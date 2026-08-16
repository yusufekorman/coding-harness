import type { AgentResult, Interruption } from "../types";
import type { AgentOptions, QuestionAsk } from "./types";
import { awaitExit, readLines, registerKill, spawnCmdStdin } from "./types";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

export async function runClaude(opts: AgentOptions): Promise<AgentResult> {
  const args: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--brief",
    "--input-format", "stream-json",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.permission) args.push("--permission-mode", opts.permission);
  if (opts.system) args.push("--append-system-prompt", opts.system);

  const proc = spawnCmdStdin(["claude", ...args]);

  registerKill(() => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* not a group leader */
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });

  const stdin = proc.stdin as unknown as {
    write?: (d: string) => unknown;
    flush?: () => unknown;
    end?: () => void;
  } | null;
  const writeStdin = (msg: unknown) => {
    try {
      stdin?.write?.(JSON.stringify(msg) + "\n");
      stdin?.flush?.();
    } catch {
      /* pipe closed */
    }
  };
  const endStdin = () => {
    try {
      stdin?.end?.();
    } catch {
      /* already closed */
    }
  };

  // write the first user message to stdin (not argv)
  writeStdin({ type: "user", message: { role: "user", content: opts.prompt } });

  let resultText = "";
  let isError = false;
  let denials: string[] = [];
  let sawResult = false;
  let costUsd: number | undefined;
  let tokens: number | undefined;
  let interruption: Interruption | undefined;

  const stdoutDone = readLines(proc.stdout, async (line) => {
    const l = line.trim();
    if (!l) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(l) as Record<string, unknown>;
    } catch {
      return;
    }

    if (ev.type === "assistant") {
      const msg = ev.message as { content?: ContentBlock[] } | undefined;
      for (const b of msg?.content ?? []) {
        if (b.type === "text" && typeof b.text === "string" && b.text) {
          opts.onText?.(b.text);
        } else if (b.type === "tool_use" && b.name === "SendUserMessage") {
          const question = typeof b.input?.message === "string" ? b.input.message : "";
          if (opts.onQuestion && question && b.id) {
            const ask: QuestionAsk = { id: b.id, questions: [{ question }] };
            const answers = await opts.onQuestion(ask);
            if (answers && answers.length) {
              writeStdin({
                type: "user",
                message: {
                  role: "user",
                  content: [{ type: "tool_result", tool_use_id: b.id, content: answers[0] }],
                },
              });
            } else {
              endStdin();
            }
          }
        }
      }
    } else if (ev.type === "result") {
      sawResult = true;
      if (typeof ev.result === "string") resultText = ev.result;
      isError = ev.is_error === true;
      if (typeof ev.total_cost_usd === "number") costUsd = ev.total_cost_usd;
      const usage = ev.usage as Record<string, unknown> | undefined;
      if (usage) {
        const i = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const o = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        tokens = i + o;
      }
      if (Array.isArray(ev.permission_denials)) {
        denials = (ev.permission_denials as Array<unknown>).map((d) => {
          if (d && typeof d === "object") {
            const o = d as Record<string, unknown>;
            return String(o.tool_name ?? o.rule ?? o.tool ?? JSON.stringify(d));
          }
          return String(d);
        });
      }
      endStdin();
    }
  });

  const exitCode = await awaitExit(proc);
  await stdoutDone;
  registerKill(null);
  const stderr = await new Response(proc.stderr).text();

  const output = sawResult ? resultText : "";
  const fallback = output || stderr.trim();

  if (exitCode !== 0 || isError) {
    interruption = {
      kind: "error",
      message: `claude error (exit ${exitCode}): ${stderr.trim() || output || "unknown"}`,
    };
  } else if (denials.length > 0) {
    interruption = { kind: "denied", message: `permission denied: ${denials.join(", ")}` };
  }

  return {
    ok: !interruption,
    output: output || fallback,
    exitCode,
    interruption,
    costUsd,
    tokens,
  };
}
