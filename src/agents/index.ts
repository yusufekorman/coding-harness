import type { AgentResult } from "../types";
import type { AgentOptions } from "./types";
import { runOpencode, closeOpencode } from "./opencode";
import { runClaude } from "./claude";
import { runAntigravity } from "./antigravity";

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  if (opts.tool === "opencode") return runOpencode(opts);
  if (opts.tool === "claude") return runClaude(opts);
  if (opts.tool === "antigravity") return runAntigravity(opts);
  throw new Error(`Unknown tool: ${opts.tool}`);
}

export async function closeAgents(): Promise<void> {
  closeOpencode();
}

export type { AgentOptions, PermissionAsk, QuestionAsk, PermissionReply } from "./types";
