import { createOpencode } from "@opencode-ai/sdk/v2";
import type { AgentResult, Interruption } from "../types";
import type { AgentOptions, PermissionAsk, QuestionAsk, QuestionItem } from "./types";
import { registerKill } from "./types";

type OpencodeServer = Awaited<ReturnType<typeof createOpencode>>;

let server: OpencodeServer | null = null;

const STEP_TIMEOUT_MS = Number(process.env.HARNESS_STEP_TIMEOUT_MS ?? 15 * 60 * 1000);

async function getServer(): Promise<OpencodeServer> {
  if (!server) {
    server = await createOpencode({ port: 0 });
  }
  return server;
}

export function closeOpencode(): void {
  if (server) {
    try {
      server.server.close();
    } catch {
      /* ignore */
    }
    server = null;
  }
}

function splitModel(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf("/");
  if (idx === -1) return { providerID: "opencode", modelID: model };
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

export async function runOpencode(opts: AgentOptions): Promise<AgentResult> {
  const { client } = await getServer();

  const output: string[] = [];
  let costUsd: number | undefined;
  let tokens: number | undefined;
  let interruption: Interruption | undefined;
  let errorMsg = "";
  let sessionID = "";
  let completed = false;

  try {
    const ruleset = Object.entries(opts.permissions ?? {}).map(([permission, action]) => ({
      permission,
      pattern: "*",
      action: action === "deny" ? "deny" : action === "ask" ? "ask" : "allow",
    }));

    const created = await client.session.create({
      directory: opts.workdir,
      permission: ruleset as never,
    });
    if (!created.data) {
      throw new Error(`could not create opencode session: ${JSON.stringify(created.error ?? {})}`);
    }
    sessionID = created.data.id;

    const timer = setTimeout(() => {
      client.session
        .abort({ sessionID })
        .catch(() => {});
    }, STEP_TIMEOUT_MS);

    registerKill(() => {
      try {
        client.session.abort({ sessionID }).catch(() => {});
      } catch {
        /* ignore */
      }
    });

    const sse = await client.event.subscribe({ directory: opts.workdir });

    const eventLoop = (async () => {
      for await (const raw of sse.stream) {
        const evt = raw as {
          type: string;
          properties: Record<string, unknown>;
        };
        if (evt.type === "message.part.delta") {
          const p = evt.properties;
          if (p.sessionID === sessionID && p.field === "text" && typeof p.delta === "string") {
            opts.onText?.(p.delta);
          }
        } else if (evt.type === "permission.asked" && opts.onPermission) {
          const p = evt.properties as unknown as {
            id: string;
            permission: string;
            patterns: string[];
          };
          const ask: PermissionAsk = { id: p.id, permission: p.permission, patterns: p.patterns ?? [] };
          const reply = await opts.onPermission(ask);
          await client.permission.reply({ requestID: p.id, reply }).catch(() => {});
        } else if (evt.type === "question.asked" && opts.onQuestion) {
          const p = evt.properties as unknown as {
            id: string;
            questions: Array<{
              question: string;
              options?: Array<{ label: string; description?: string }>;
              multiple?: boolean;
              custom?: boolean;
            }>;
          };
          const questions: QuestionItem[] = (p.questions ?? []).map((q) => ({
            question: q.question,
            options: q.options,
            multiple: q.multiple,
            custom: q.custom,
          }));
          const ask: QuestionAsk = { id: p.id, questions };
          const answers = await opts.onQuestion(ask);
          if (answers && answers.length) {
            await client.question
              .reply({ requestID: p.id, answers: answers.map((a) => [a]) })
              .catch(() => {});
          } else {
            await client.question.reject({ requestID: p.id }).catch(() => {});
          }
        } else if (evt.type === "session.error") {
          const p = evt.properties;
          if (!p.sessionID || p.sessionID === sessionID) {
            errorMsg = JSON.stringify(p.error ?? "opencode session error");
          }
        }
      }
    })();

    const model = opts.model ? splitModel(opts.model) : undefined;
    const prompted = await client.session.prompt({
      sessionID,
      directory: opts.workdir,
      model,
      variant: opts.variant,
      system: opts.system,
      parts: [{ type: "text", text: opts.prompt }],
    });
    completed = true;
    clearTimeout(timer);

    if (prompted.data) {
      const info = prompted.data.info as { cost?: number; tokens?: { total?: number; input?: number; output?: number }; error?: unknown };
      if (typeof info?.cost === "number") costUsd = info.cost;
      if (info?.tokens) tokens = info.tokens.total ?? (info.tokens.input ?? 0) + (info.tokens.output ?? 0);
      if (info?.error) {
        errorMsg = JSON.stringify(info.error);
      }
      for (const part of prompted.data.parts ?? []) {
        if (part.type === "text" && part.text) output.push(part.text);
      }
    } else if (prompted.error) {
      errorMsg = JSON.stringify(prompted.error);
    }

    await sse.stream.return(undefined as never);
    await eventLoop;
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : String(e);
  } finally {
    registerKill(null);
  }

  const out = output.join("\n").trim();

  if (errorMsg && !completed) {
    interruption = { kind: "error", message: errorMsg };
  } else if (errorMsg) {
    interruption = { kind: "error", message: errorMsg };
  }

  return {
    ok: !interruption,
    output: out,
    exitCode: interruption ? 1 : 0,
    interruption,
    costUsd,
    tokens,
  };
}
