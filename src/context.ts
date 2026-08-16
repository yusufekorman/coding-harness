import type { StepContext } from "./types";

export function render(
  template: string,
  ctx: StepContext,
  extra: Record<string, string> = {},
): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, raw: string) => {
    const key = raw;
    if (key === "task") return ctx.task;
    if (key === "workdir") return ctx.workdir;
    if (key === "effort") return ctx.effort;
    if (key === "workflow") return ctx.workflow.name ?? ctx.workflow.id;
    if (key.startsWith("context.")) return ctx.values[key.slice("context.".length)] ?? "";
    return extra[key] ?? "";
  });
}
