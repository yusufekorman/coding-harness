export type Role = "orchestrator" | "architect" | "coder";
export type Tool = "opencode" | "claude";
export type Effort = "medium" | "high";

export interface RoleResolution {
  tool: Tool;
  model?: string;
  /** claude --effort */
  effort?: string;
  /** opencode --variant */
  variant?: string;
}

export interface SafetyConfig {
  /** yazma yetkili adımların bu dizinler içinde çalışmasını engelle */
  protectedDirs: string[];
  /** false iken coder adımı --auto olmadan çalışır (yazmalar denial'a düşer) */
  autoApprove: boolean;
}

export interface HarnessConfig {
  defaultEffort?: Effort;
  maxRetries?: number;
  maxTransientRetries?: number;
  transientBackoffMs?: number;
  safety?: SafetyConfig;
  /** kategori bazlı izin politikası (opencode): read/edit/bash/webfetch/... -> allow|ask|deny */
  permissions?: Record<string, "allow" | "deny" | "ask">;
  efforts: Record<Effort, Record<Role, RoleResolution>>;
}

export interface Step {
  id: string;
  name?: string;
  role?: Role;
  tool?: Tool;
  model?: string;
  permission?: string;
  auto?: boolean;
  variant?: string;
  effort?: string;
  system?: string;
  prompt: string;
  captures?: string;
  review?: boolean;
}

export interface Workflow {
  id: string;
  name?: string;
  description?: string;
  steps: Step[];
}

export type InterruptionKind = "error" | "denied" | "question";

export interface Interruption {
  kind: InterruptionKind;
  message: string;
}

export interface AgentResult {
  ok: boolean;
  output: string;
  exitCode: number;
  interruption?: Interruption;
  /** toplam maliyet (USD), biliniyorsa */
  costUsd?: number;
  /** toplam token sayısı, biliniyorsa */
  tokens?: number;
}

export type DecisionAction = "complete" | "answer" | "retry" | "escalate" | "abort";

export interface Decision {
  action: DecisionAction;
  response?: string;
  instruction?: string;
  reason?: string;
}

export interface StepContext {
  task: string;
  workdir: string;
  effort: Effort;
  workflow: Workflow;
  values: Record<string, string>;
}

export type RunEvent =
  | { type: "start"; task: string; workflow: string; effort: Effort; workdir: string }
  | {
      type: "step_start";
      index: number;
      total: number;
      id: string;
      name?: string;
      tool: string;
      model?: string;
      effort?: string;
      variant?: string;
    }
  | { type: "output"; chunk: string }
  | {
      type: "step_end";
      index: number;
      id: string;
      ok: boolean;
      interruption?: string;
      costUsd?: number;
      tokens?: number;
      durationMs: number;
    }
  | { type: "decision"; id: string; action: string; reason?: string }
  | { type: "question"; id: string; message: string }
  | { type: "progress"; index: number; values: Record<string, string> }
  | { type: "end"; values: Record<string, string> }
  | { type: "error"; message: string };
