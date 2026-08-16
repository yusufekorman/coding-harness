import type { Decision, HarnessConfig, Interruption, Step, StepContext } from "./types";
import { resolveRole } from "./config";
import { runAgent, type AgentOptions, type PermissionAsk, type PermissionReply, type QuestionAsk } from "./agents";
import { extractJson } from "./json";

const MAX_CONTEXT = 6000;

function truncate(s: string, n = MAX_CONTEXT): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "\n...[truncated]";
}

/** The orchestrator's own decision call: no tool use, no ask/permission hangs */
function decisionAgentOpts(cfg: HarnessConfig, ctx: StepContext, prompt: string): AgentOptions {
  const role = resolveRole(cfg, ctx.effort, "orchestrator");
  return {
    tool: role.tool,
    model: role.model,
    variant: role.variant,
    effort: role.effort,
    permission: "plan",
    prompt,
    workdir: ctx.workdir,
    permissions: {
      read: "allow",
      grep: "allow",
      glob: "allow",
      list: "allow",
      lsp: "allow",
      edit: "deny",
      bash: "deny",
      task: "deny",
      webfetch: "deny",
      websearch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
      question: "deny",
    },
    onPermission: async () => "reject",
    onQuestion: async () => null,
  };
}

function buildPrompt(
  ctx: StepContext,
  step: Step,
  output: string,
  interruption: Interruption | undefined,
  retriesUsed: number,
): string {
  const lines = [
    "You are a task orchestrator. A step of a coding workflow has run; evaluate the result and return a single JSON decision object.",
    "",
    `Original task: ${ctx.task}`,
    `Current step: ${step.id}${step.name ? " — " + step.name : ""}`,
    `Step instruction: ${step.prompt}`,
    "",
    "Agent output:",
    "---",
    truncate(output || "(empty)"),
    "---",
  ];

  if (interruption) {
    lines.push("", `Detected interruption: ${interruption.kind} — ${truncate(interruption.message, 1000)}`);
  }

  lines.push(
    "",
    `Retries used for this step: ${retriesUsed}`,
    "",
    "Return only this JSON (write no other text, use no tools):",
    JSON.stringify({
      action: "complete | answer | retry | escalate | abort",
      response: "for answer: the answer to the agent's question; for escalate: the question to ask the user",
      instruction: "for retry: extra instructions for the agent to follow when redoing the step",
      reason: "short reason",
    }),
    "",
    "Rules:",
    "- If the step completed successfully, action=complete.",
    "- If the agent asked a question or information is missing and you know the answer, action=answer (response=answer).",
    "- If you don't know the answer either and the user genuinely needs to be asked, action=escalate (response=question).",
    "- If the step failed or a different approach is needed, action=retry (instruction=instruction).",
    "- If the task is impossible, action=abort.",
    "- Only escalate when necessary; use answer/retry for easy decisions.",
  );
  return lines.join("\n");
}

function parseDecision(text: string): Decision {
  const json = extractJson(text) as Record<string, unknown> | null;
  if (json) {
    const action = json.action;
    if (["complete", "answer", "retry", "escalate", "abort"].includes(String(action))) {
      return {
        action: String(action) as Decision["action"],
        response: typeof json.response === "string" ? json.response : undefined,
        instruction: typeof json.instruction === "string" ? json.instruction : undefined,
        reason: typeof json.reason === "string" ? json.reason : undefined,
      };
    }
  }

  const lower = text.toLowerCase();
  if (lower.includes("abort")) return { action: "abort" };
  if (lower.includes("escalate")) return { action: "escalate", response: text };
  // Decision JSON could not be produced -> silently saying "completed" is dangerous; relay to the user.
  return {
    action: "escalate",
    response: `Orchestrator could not produce a decision. Raw output:\n${text.trim() || "(empty)"}`,
    reason: "decision could not be parsed",
  };
}

export async function decide(
  cfg: HarnessConfig,
  ctx: StepContext,
  step: Step,
  output: string,
  interruption: Interruption | undefined,
  retriesUsed: number,
): Promise<Decision> {
  const prompt = buildPrompt(ctx, step, output, interruption, retriesUsed);
  const result = await runAgent(decisionAgentOpts(cfg, ctx, prompt));

  if (!result.output.trim() || result.interruption) {
    return {
      action: "escalate",
      response: `Orchestrator agent errored: ${result.interruption?.message ?? "empty output"}`,
      reason: "orchestrator errored",
    };
  }

  return parseDecision(result.output);
}

export interface PermissionDecision {
  reply?: PermissionReply;
  escalate?: boolean;
  question?: string;
}

export async function decidePermission(
  cfg: HarnessConfig,
  ctx: StepContext,
  step: Step,
  ask: PermissionAsk,
): Promise<PermissionDecision> {
  const prompt = [
    "You are a task orchestrator. A coding agent is requesting a permission. Evaluate it and return a single JSON object.",
    "",
    `Original task: ${ctx.task}`,
    `Current step: ${step.id}${step.name ? " — " + step.name : ""}`,
    `Permission type: ${ask.permission}`,
    `Patterns: ${truncate((ask.patterns ?? []).join(", ") || "(none)", 500)}`,
    "",
    "Return only this JSON (use no tools):",
    JSON.stringify({ reply: "once | always | reject", reason: "short reason" }),
    'or if unsure: {"escalate": true, "question": "question to ask the user"}',
    "",
    "Rules:",
    "- If it's a safe/routine permission, reply=once (or always for permanent).",
    "- If risky/destructive, reply=reject.",
    "- If you can't decide, escalate.",
  ].join("\n");

  const result = await runAgent(decisionAgentOpts(cfg, ctx, prompt));
  const json = extractJson(result.output) as Record<string, unknown> | null;

  if (json?.escalate) {
    return { escalate: true, question: typeof json.question === "string" ? json.question : undefined };
  }
  if (json && ["once", "always", "reject"].includes(String(json.reply))) {
    return { reply: String(json.reply) as PermissionReply };
  }
  // if unknown, err on the safe side: relay to the user instead of rejecting
  return { escalate: true, question: `Permission request (${ask.permission}): ${(ask.patterns ?? []).join(", ")} — allow it?` };
}

export interface QuestionDecision {
  answers?: string[];
  escalate?: boolean;
}

export async function decideQuestion(
  cfg: HarnessConfig,
  ctx: StepContext,
  step: Step,
  ask: QuestionAsk,
): Promise<QuestionDecision> {
  const qs = ask.questions
    .map((q, i) => {
      let s = `${i + 1}. ${q.question}`;
      if (q.options?.length) s += ` [options: ${q.options.map((o) => o.label).join(", ")}]`;
      return s;
    })
    .join("\n");

  const prompt = [
    "You are a task orchestrator. A coding agent asked the user a question. Answer it if you know the answer, otherwise relay it to the user (escalate).",
    "",
    `Original task: ${ctx.task}`,
    `Current step: ${step.id}${step.name ? " — " + step.name : ""}`,
    "The agent's questions:",
    qs,
    "",
    "Return only this JSON (use no tools):",
    JSON.stringify({ answers: ["answer to question 1", "answer to question 2"], reason: "short reason" }),
    'or: {"escalate": true}',
    "",
    "Rules:",
    "- One answer per question (answers array, in order).",
    "- If unsure about the answers, escalate; don't make up answers.",
  ].join("\n");

  const result = await runAgent(decisionAgentOpts(cfg, ctx, prompt));
  const json = extractJson(result.output) as Record<string, unknown> | null;

  if (json && Array.isArray(json.answers)) {
    return { answers: json.answers.map((a) => String(a)) };
  }
  if (json?.escalate) {
    return { escalate: true };
  }
  return { escalate: true };
}
