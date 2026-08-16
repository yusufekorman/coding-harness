import type { Subprocess } from "bun";
import type { Tool } from "../types";

export interface PermissionAsk {
  id: string;
  permission: string;
  patterns: string[];
}

export interface QuestionItem {
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionAsk {
  id: string;
  questions: QuestionItem[];
}

export type PermissionReply = "once" | "always" | "reject";

export interface AgentOptions {
  tool: Tool;
  prompt: string;
  workdir: string;
  model?: string;
  effort?: string;
  variant?: string;
  permission?: string;
  auto?: boolean;
  system?: string;
  /** per-category permission policy (for the opencode native ruleset) */
  permissions?: Record<string, "allow" | "deny" | "ask">;
  /** live streamed text (for the TUI log) */
  onText?: (chunk: string) => void;
  /** when the agent asks a question — live, same session; returned answers are written back (null = reject) */
  onQuestion?: (ask: QuestionAsk) => Promise<string[] | null>;
  /** when the agent requests permission — live; the reply is written back */
  onPermission?: (ask: PermissionAsk) => Promise<PermissionReply>;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.HARNESS_STEP_TIMEOUT_MS ?? 15 * 60 * 1000);

interface Proc {
  exited: Promise<number>;
  kill: (signal?: number) => void;
  pid: number;
}

function killGroup(proc: Proc): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    /* not a group leader */
  }
  try {
    proc.kill(9);
  } catch {
    /* already gone */
  }
}

export async function awaitExit(proc: Proc): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (DEFAULT_TIMEOUT_MS > 0) {
    timer = setTimeout(() => killGroup(proc), DEFAULT_TIMEOUT_MS);
  }
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return code;
}

let currentKill: (() => void) | null = null;

export function registerKill(kill: (() => void) | null): void {
  currentKill = kill;
}

export function abortCurrent(): void {
  if (currentKill) {
    try {
      currentKill();
    } catch {
      /* already gone */
    }
  }
}

/** put the child in a new process group on Linux (setsid) — so the whole tree can be killed on timeout/abort */
export function spawnCmd(cmd: string[]): Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: ["setsid", ...cmd],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
}

/** setsid + stdin open (for claude full-duplex stream-json) */
export function spawnCmdStdin(cmd: string[]): Subprocess<"pipe", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: ["setsid", ...cmd],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
  });
}

export async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void | Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        await onLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer) await onLine(buffer);
  } finally {
    reader.releaseLock();
  }
}
