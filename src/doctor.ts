import { readdirSync } from "node:fs";
import { EFFORTS, ROLES, loadConfig } from "./config";
import { loadWorkflow } from "./workflow";
import type { HarnessConfig } from "./types";

async function run(cmd: string[], timeoutMs = 20000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const t = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  const code = await proc.exited;
  clearTimeout(t);
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { code, out: `${out}\n${err}`.trim() };
}

const CLAUDE_ALIASES = new Set(["sonnet", "opus", "haiku", "fable"]);

interface ModelSets {
  opencode: Set<string>;
  antigravity: Set<string>;
}

function checkModel(tool: string, model: string, models: ModelSets): string | null {
  if (tool === "opencode") {
    if (models.opencode.has(model)) return null;
    return `opencode model not found: ${model}`;
  }
  if (tool === "claude") {
    if (CLAUDE_ALIASES.has(model) || model.startsWith("claude-")) return null;
    return `unknown claude model alias: ${model} (${[...CLAUDE_ALIASES].join("|")} or claude-*)`;
  }
  if (tool === "antigravity") {
    if (models.antigravity.has(model)) return null;
    return `antigravity model slug not found: ${model} (list with 'agy models')`;
  }
  return `unknown tool: ${tool}`;
}

function discoverWorkflows(root: string): string[] {
  try {
    const ids = new Set<string>();
    for (const f of readdirSync(`${root}/workflows`)) {
      const m = f.match(/^(.+)\.(yaml|yml)$/i);
      if (m) ids.add(m[1]);
    }
    if (ids.size) return [...ids].sort();
  } catch {
    /* no workflows dir */
  }
  return ["FIX", "FEATURE", "ASK"];
}

function parseAgyModels(out: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of out.split("\n")) {
    const first = line.trim().split(/\s+/)[0];
    if (first && /^[a-z][a-z0-9._-]*$/.test(first)) slugs.add(first);
  }
  return slugs;
}

export async function doctor(root: string): Promise<number> {
  const ok: string[] = [];
  const problems: string[] = [];

  const present: Record<string, boolean> = {};
  for (const cli of ["opencode", "claude", "agy"]) {
    const r = await run([cli, "--version"], 15000);
    if (r.code === 0) {
      ok.push(`${cli}: present (${r.out.split("\n")[0]})`);
      present[cli] = true;
    } else {
      problems.push(`${cli}: could not run (exit ${r.code})`);
      present[cli] = false;
    }
  }

  let cfg: HarnessConfig | null = null;
  try {
    cfg = await loadConfig(root);
    ok.push("config.yaml: valid");
  } catch (e) {
    problems.push(`config.yaml: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const wf of discoverWorkflows(root)) {
    try {
      await loadWorkflow(root, wf);
      ok.push(`workflow ${wf}: valid`);
    } catch (e) {
      problems.push(`workflow ${wf}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const models: ModelSets = { opencode: new Set(), antigravity: new Set() };

  const opencodeModels = await run(["opencode", "models"], 30000);
  for (const line of opencodeModels.out.split("\n")) {
    const m = line.trim();
    if (m) models.opencode.add(m);
  }

  if (present["agy"]) {
    const agyModels = await run(["agy", "models"], 30000);
    models.antigravity = parseAgyModels(agyModels.out);
  }

  if (cfg) {
    const seen = new Set<string>();
    const toolRoleCount: Record<string, number> = {};
    for (const e of EFFORTS) {
      for (const r of ROLES) {
        const res = cfg.efforts[e][r];
        toolRoleCount[res.tool] = (toolRoleCount[res.tool] ?? 0) + 1;
        const key = `${res.tool}:${res.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const problem = checkModel(res.tool, res.model ?? "", models);
        if (problem) problems.push(`efforts.${e}.${r}: ${problem}`);
        else ok.push(`efforts.${e}.${r}: ${res.tool} ${res.model} OK`);
      }
    }
    const guidance: string[] = [];
    if ((toolRoleCount["claude"] ?? 0) && !present["claude"]) {
      guidance.push(
        `config uses claude for ${toolRoleCount["claude"]} role mapping(s) but the 'claude' CLI is not available. ` +
          `Set the roles you don't need to tool: opencode in config.yaml (or override per step in the workflow).`,
      );
    }
    if ((toolRoleCount["antigravity"] ?? 0) && !present["agy"]) {
      guidance.push(
        `config uses antigravity for ${toolRoleCount["antigravity"]} role mapping(s) but the 'agy' CLI is not available. ` +
          `Install it (https://antigravity.google) or point those roles at tool: opencode / claude.`,
      );
    }
    for (const g of guidance) problems.push(g);
  }

  process.stdout.write("== harness doctor ==\n");
  for (const o of ok) process.stdout.write(`  [OK] ${o}\n`);
  for (const p of problems) process.stdout.write(`  [!!] ${p}\n`);
  process.stdout.write(problems.length ? "Result: problems found\n" : "Result: all good\n");

  return problems.length ? 1 : 0;
}
