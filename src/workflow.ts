import { parse as parseYaml } from "yaml";
import type { Role, Step, Tool, Workflow } from "./types";
import { ROLES, TOOLS } from "./config";

const PERMISSIONS = ["plan", "acceptEdits", "dontAsk", "bypassPermissions"];

export async function loadWorkflow(root: string, id: string): Promise<Workflow> {
  const candidates = [
    `${root}/workflows/${id}.yaml`,
    `${root}/workflows/${id}.yml`,
    `${root}/workflows/${id.toUpperCase()}.yaml`,
    `${root}/workflows/${id.toLowerCase()}.yaml`,
  ];

  let raw = "";
  let found = "";
  for (const c of candidates) {
    const f = Bun.file(c);
    if (await f.exists()) {
      raw = await f.text();
      found = c;
      break;
    }
  }
  if (!found) {
    throw new Error(`Workflow bulunamadı: "${id}" (arandı: ${candidates.join(", ")})`);
  }
  return validate(parseYaml(raw) as Record<string, unknown> | null, found);
}

function validate(data: Record<string, unknown> | null, source: string): Workflow {
  if (!data || typeof data !== "object") throw new Error(`Geçersiz workflow: ${source}`);
  if (!data.id) throw new Error(`Workflow.id gerekli: ${source}`);
  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    throw new Error(`Workflow.steps boş: ${source}`);
  }

  const steps: Step[] = data.steps.map((rawStep, i) => {
    const s = rawStep as Record<string, unknown>;
    if (!s.id) throw new Error(`${source}: steps[${i}].id gerekli`);
    if (typeof s.prompt !== "string" || !s.prompt.trim()) {
      throw new Error(`${source}: steps[${i}].prompt gerekli`);
    }
    const role = s.role as Role | undefined;
    if (role && !ROLES.includes(role)) {
      throw new Error(`${source}: steps[${i}].role geçersiz: ${role}`);
    }
    const tool = s.tool as Tool | undefined;
    if (tool && !TOOLS.includes(tool)) {
      throw new Error(`${source}: steps[${i}].tool geçersiz: ${tool}`);
    }
    const permission = typeof s.permission === "string" ? s.permission : undefined;
    if (permission && !PERMISSIONS.includes(permission)) {
      throw new Error(`${source}: steps[${i}].permission geçersiz: ${permission}`);
    }
    if (typeof s.prompt === "string" && s.prompt.length > 100_000) {
      throw new Error(`${source}: steps[${i}].prompt çok uzun`);
    }
    return {
      id: String(s.id),
      name: typeof s.name === "string" ? s.name : undefined,
      role,
      tool,
      model: typeof s.model === "string" ? s.model : undefined,
      permission,
      auto: s.auto === true,
      variant: typeof s.variant === "string" ? s.variant : undefined,
      effort: typeof s.effort === "string" ? s.effort : undefined,
      system: typeof s.system === "string" ? s.system : undefined,
      prompt: s.prompt,
      captures: typeof s.captures === "string" ? s.captures : undefined,
      review: s.review !== false,
    };
  });

  return {
    id: String(data.id),
    name: typeof data.name === "string" ? data.name : undefined,
    description: typeof data.description === "string" ? data.description : undefined,
    steps,
  };
}
