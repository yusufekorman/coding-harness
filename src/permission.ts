import type { HarnessConfig } from "./types";

export type PermissionAction = "allow" | "deny" | "ask";

const DEFAULTS: Record<string, PermissionAction> = {
  read: "allow",
  grep: "allow",
  glob: "allow",
  list: "allow",
  lsp: "allow",
  codesearch: "allow",
  websearch: "allow",
  edit: "allow",
  webfetch: "allow",
  task: "allow",
  bash: "ask",
  external_directory: "ask",
  todowrite: "ask",
  doom_loop: "deny",
  question: "ask",
};

export function permissionAction(cfg: HarnessConfig, key: string): PermissionAction {
  const user = cfg.permissions?.[key];
  if (user === "allow" || user === "deny" || user === "ask") return user;
  return DEFAULTS[key] ?? "ask";
}

export function permissionRuleset(cfg: HarnessConfig): Record<string, PermissionAction> {
  const out: Record<string, PermissionAction> = { ...DEFAULTS };
  for (const [k, v] of Object.entries(cfg.permissions ?? {})) {
    out[k] = v;
  }
  return out;
}
