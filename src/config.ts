import { parse as parseYaml } from "yaml";
import type { Effort, HarnessConfig, Role, RoleResolution, Step } from "./types";

export const DEFAULT_EFFORT: Effort = "medium";
export const EFFORTS: Effort[] = ["medium", "high"];
export const ROLES: Role[] = ["orchestrator", "architect", "coder"];
export const TOOLS = ["opencode", "claude", "antigravity"] as const;

const DEFAULT_CONFIG: HarnessConfig = {
  defaultEffort: DEFAULT_EFFORT,
  maxRetries: 3,
  maxTransientRetries: 3,
  transientBackoffMs: 2000,
  safety: {
    protectedDirs: ["$HOME", "/", "/etc", "/usr", "/bin", "/boot", "/dev", "/lib", "/proc", "/sys"],
    autoApprove: true,
  },
  efforts: {
    medium: {
      orchestrator: { tool: "opencode", model: "opencode-go/deepseek-v4-flash", variant: "medium" },
      architect: { tool: "claude", model: "sonnet", effort: "high" },
      coder: { tool: "opencode", model: "opencode-go/deepseek-v4-pro", variant: "medium" },
    },
    high: {
      orchestrator: { tool: "opencode", model: "opencode-go/deepseek-v4-flash", variant: "high" },
      architect: { tool: "claude", model: "opus", effort: "medium" },
      coder: { tool: "opencode", model: "opencode-go/deepseek-v4-pro", variant: "high" },
    },
  },
};

export async function loadConfig(root: string): Promise<HarnessConfig> {
  const file = Bun.file(`${root}/config.yaml`);
  if (!(await file.exists())) return DEFAULT_CONFIG;

  const parsed = parseYaml(await file.text()) as Partial<HarnessConfig> | null;
  if (!parsed || typeof parsed !== "object") return DEFAULT_CONFIG;

  const cfg: HarnessConfig = {
    defaultEffort: parsed.defaultEffort ?? DEFAULT_CONFIG.defaultEffort,
    maxRetries: parsed.maxRetries ?? DEFAULT_CONFIG.maxRetries,
    maxTransientRetries: parsed.maxTransientRetries ?? DEFAULT_CONFIG.maxTransientRetries,
    transientBackoffMs: parsed.transientBackoffMs ?? DEFAULT_CONFIG.transientBackoffMs,
    safety: {
      protectedDirs: parsed.safety?.protectedDirs ?? DEFAULT_CONFIG.safety?.protectedDirs ?? [],
      autoApprove: parsed.safety?.autoApprove ?? DEFAULT_CONFIG.safety?.autoApprove ?? true,
    },
    permissions: parsed.permissions ?? {},
    efforts: {
      medium: { ...DEFAULT_CONFIG.efforts.medium, ...parsed.efforts?.medium },
      high: { ...DEFAULT_CONFIG.efforts.high, ...parsed.efforts?.high },
    },
  };

  const errors = validateConfig(cfg);
  if (errors.length) {
    throw new Error(`invalid config.yaml:\n- ${errors.join("\n- ")}`);
  }
  return cfg;
}

export function validateConfig(cfg: HarnessConfig): string[] {
  const errors: string[] = [];
  if (cfg.defaultEffort && !EFFORTS.includes(cfg.defaultEffort)) {
    errors.push(`invalid defaultEffort: ${cfg.defaultEffort} (${EFFORTS.join("|")})`);
  }
  for (const e of EFFORTS) {
    const bucket = cfg.efforts[e];
    if (!bucket) {
      errors.push(`efforts.${e} is missing`);
      continue;
    }
    for (const r of ROLES) {
      const res = bucket[r] as RoleResolution | undefined;
      if (!res || typeof res !== "object") {
        errors.push(`efforts.${e}.${r} is missing`);
        continue;
      }
      if (!TOOLS.includes(res.tool as (typeof TOOLS)[number])) {
        errors.push(`invalid efforts.${e}.${r}.tool: ${res.tool} (${TOOLS.join("|")})`);
      }
      if (!res.model || !res.model.trim()) {
        errors.push(`efforts.${e}.${r}.model is empty`);
      }
    }
  }
  if (typeof cfg.maxRetries !== "number" || cfg.maxRetries < 0) {
    errors.push(`maxRetries must be a number (>= 0)`);
  }
  if (typeof cfg.maxTransientRetries !== "number" || cfg.maxTransientRetries < 0) {
    errors.push(`maxTransientRetries must be a number (>= 0)`);
  }
  return errors;
}

export function resolveRole(
  cfg: HarnessConfig,
  effort: Effort,
  role: Role,
  step?: Step,
): RoleResolution {
  const base: RoleResolution = cfg.efforts[effort]?.[role] ?? { tool: "opencode" };
  const resolved: RoleResolution = { ...base };
  if (step?.tool) resolved.tool = step.tool;
  if (step?.model) resolved.model = step.model;
  if (step?.variant) resolved.variant = step.variant;
  if (step?.effort) resolved.effort = step.effort;
  return resolved;
}
