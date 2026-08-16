import type {
  AgentResult,
  Decision,
  HarnessConfig,
  Role,
  RoleResolution,
  RunEvent,
  Step,
  StepContext,
} from "./types";
import { resolveRole } from "./config";
import { render } from "./context";
import { runAgent, type AgentOptions, type PermissionAsk, type QuestionAsk } from "./agents";
import { decide, decidePermission, decideQuestion } from "./orchestrator";
import { assertSafeWorkdir } from "./safety";
import { permissionRuleset } from "./permission";

export interface RunHooks {
  onStepStart?(step: Step, index: number, total: number, label: string): void;
  onOutput?(chunk: string): void;
  onStepEnd?(step: Step, result: AgentResult): void;
  onDecision?(step: Step, decision: Decision): void;
  onEvent?(event: RunEvent): void;
  ask(question: string): Promise<string>;
}

export class AbortError extends Error {}

function defaultPermission(role: Role): string {
  return role === "coder" ? "acceptEdits" : "plan";
}

function describe(resolved: RoleResolution): string {
  const parts: string[] = [resolved.tool];
  if (resolved.model) parts.push(resolved.model);
  if (resolved.effort) parts.push(`effort ${resolved.effort}`);
  if (resolved.variant) parts.push(`variant ${resolved.variant}`);
  return parts.join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isTransient(result: AgentResult): boolean {
  return result.interruption?.kind === "error" && result.output.trim() === "";
}

async function runWithTransientRetry(
  opts: AgentOptions,
  max: number,
  backoff: number,
): Promise<AgentResult> {
  let result = await runAgent(opts);
  for (let attempt = 1; attempt <= max && isTransient(result); attempt++) {
    await sleep(backoff * 2 ** (attempt - 1));
    result = await runAgent(opts);
  }
  return result;
}

function resolvePermissions(cfg: HarnessConfig): Record<string, "allow" | "deny" | "ask"> {
  const policy = permissionRuleset(cfg);
  if (cfg.safety?.autoApprove === false) {
    return Object.fromEntries(Object.keys(policy).map((k) => [k, "ask" as const]));
  }
  return policy;
}

export async function runWorkflow(
  cfg: HarnessConfig,
  ctx: StepContext,
  hooks: RunHooks,
  startIndex = 0,
): Promise<Record<string, string>> {
  const maxRetries = cfg.maxRetries ?? 3;
  const maxTransient = cfg.maxTransientRetries ?? 3;
  const backoffMs = cfg.transientBackoffMs ?? 2000;
  const total = ctx.workflow.steps.length;
  const permissions = resolvePermissions(cfg);

  hooks.onEvent?.({
    type: "start",
    task: ctx.task,
    workflow: ctx.workflow.id,
    effort: ctx.effort,
    workdir: ctx.workdir,
  });

  for (let i = startIndex; i < total; i++) {
    const stepDef = ctx.workflow.steps[i];
    const role: Role = stepDef.role ?? "coder";

    assertSafeWorkdir(cfg, ctx.workdir, stepDef, role);

    const resolved = resolveRole(cfg, ctx.effort, role, stepDef);
    const label = describe(resolved);

    hooks.onStepStart?.(stepDef, i, total, label);
    hooks.onEvent?.({
      type: "step_start",
      index: i,
      total,
      id: stepDef.id,
      name: stepDef.name,
      tool: resolved.tool,
      model: resolved.model,
      effort: resolved.effort,
      variant: resolved.variant,
    });

    let prompt = render(stepDef.prompt, ctx);
    let streamBuf = "";
    let done = false;
    let retries = 0;
    let output = "";

    const makeAgentOpts = (): AgentOptions => ({
      tool: resolved.tool,
      model: resolved.model,
      effort: resolved.effort,
      variant: resolved.variant,
      permission: stepDef.permission ?? defaultPermission(role),
      system: stepDef.system,
      prompt,
      workdir: ctx.workdir,
      permissions,
      onText: (c) => {
        streamBuf += c;
        hooks.onOutput?.(c);
        hooks.onEvent?.({ type: "output", chunk: c });
      },
      onQuestion: async (ask: QuestionAsk) => {
        hooks.onEvent?.({
          type: "question",
          id: stepDef.id,
          message: ask.questions.map((q) => q.question).join(" | "),
        });
        const decision = await decideQuestion(cfg, ctx, stepDef, ask);
        if (decision.answers) return decision.answers;
        if (decision.escalate) {
          const q = ask.questions.map((x) => x.question).join("\n");
          const userAnswer = await hooks.ask(q);
          if (!userAnswer) return null;
          return [userAnswer];
        }
        return null;
      },
      onPermission: async (ask: PermissionAsk) => {
        const decision = await decidePermission(cfg, ctx, stepDef, ask);
        if (decision.reply) return decision.reply;
        if (decision.escalate) {
          const msg = `Permission: ${ask.permission}${ask.patterns?.length ? " — " + ask.patterns.join(", ") : ""}`;
          const userAnswer = await hooks.ask(`${msg}\n[allow/deny]`);
          if (/^a|^y|^yes|^ok|^allow/i.test(userAnswer)) return "once";
          return "reject";
        }
        return "reject";
      },
    });

    while (!done) {
      const started = Date.now();

      const result = await runWithTransientRetry(makeAgentOpts(), maxTransient, backoffMs);

      output = result.output.trim() ? result.output : streamBuf;
      const durationMs = Date.now() - started;

      hooks.onStepEnd?.(stepDef, result);
      hooks.onEvent?.({
        type: "step_end",
        index: i,
        id: stepDef.id,
        ok: result.ok,
        interruption: result.interruption ? `${result.interruption.kind}: ${result.interruption.message}` : undefined,
        costUsd: result.costUsd,
        tokens: result.tokens,
        durationMs,
      });

      const needsReview = result.interruption != null || stepDef.review !== false;
      if (!needsReview) {
        done = true;
        break;
      }

      const decision: Decision = await decide(cfg, ctx, stepDef, output, result.interruption, retries);
      hooks.onDecision?.(stepDef, decision);
      hooks.onEvent?.({
        type: "decision",
        id: stepDef.id,
        action: decision.action,
        reason: decision.reason,
      });

      switch (decision.action) {
        case "complete":
          done = true;
          break;
        case "answer":
        case "retry": {
          const note = decision.action === "answer" ? decision.response ?? "" : decision.instruction ?? "";
          prompt = `${prompt}\n\n[${decision.action === "answer" ? "Answer to question" : "Extra instruction"}: ${note}]`;
          retries++;
          break;
        }
        case "escalate": {
          const question = decision.response ?? "How should I proceed with this step?";
          const userAnswer = await hooks.ask(question);
          if (!userAnswer) {
            throw new AbortError("user left it empty");
          }
          prompt = `${prompt}\n\n[User answer: ${userAnswer}]`;
          retries++;
          break;
        }
        case "abort":
          throw new AbortError("orchestrator aborted");
      }

      if (!done && retries > maxRetries) {
        const userAnswer = await hooks.ask(
          `Step "${stepDef.id}" was retried ${maxRetries} times and didn't finish. How should I proceed? (empty=abort)`,
        );
        if (!userAnswer) {
          throw new AbortError("user left it empty");
        }
        prompt = `${prompt}\n\n[User answer: ${userAnswer}]`;
        retries = 0;
      }
    }

    const key = stepDef.captures ?? stepDef.id;
    ctx.values[key] = output;
    hooks.onEvent?.({ type: "progress", index: i, values: { ...ctx.values } });
  }

  hooks.onEvent?.({ type: "end", values: { ...ctx.values } });
  return ctx.values;
}
