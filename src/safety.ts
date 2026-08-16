import { resolve, sep } from "node:path";
import type { HarnessConfig, Role, Step } from "./types";

function expand(raw: string): string {
  if (raw === "$HOME" || raw === "~") return process.env.HOME ?? "";
  return raw;
}

export function isProtectedDir(workdir: string, protectedDirs: string[]): boolean {
  const wd = resolve(workdir);
  for (const raw of protectedDirs) {
    const p = resolve(expand(raw));
    if (!p) continue;
    // $HOME/~ is only protected on an exact match; subproject directories (e.g. ~/Projects/...) remain free
    const exactOnly = raw === "$HOME" || raw === "~";
    if (exactOnly ? wd === p : wd === p || wd.startsWith(p + sep)) return true;
  }
  return false;
}

export function isWriteStep(step: Step, role: Role): boolean {
  if (role === "coder") return true;
  if (step.auto === true) return true;
  if (step.permission && step.permission !== "plan") return true;
  return false;
}

export function assertSafeWorkdir(
  cfg: HarnessConfig,
  workdir: string,
  step: Step,
  role: Role,
): void {
  if (!isWriteStep(step, role)) return;
  const dirs = cfg.safety?.protectedDirs ?? [];
  if (isProtectedDir(workdir, dirs)) {
    throw new Error(
      `safety: ${workdir} is inside a protected directory; the write-capable step "${step.id}" was refused. ` +
        `To allow it, edit safety.protectedDirs in config.yaml.`,
    );
  }
}
