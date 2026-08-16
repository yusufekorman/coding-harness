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

function checkModel(tool: string, model: string, opencodeModels: Set<string>): string | null {
  if (tool === "opencode") {
    if (opencodeModels.has(model)) return null;
    return `opencode model not found: ${model}`;
  }
  if (tool === "claude") {
    if (CLAUDE_ALIASES.has(model) || model.startsWith("claude-")) return null;
    return `unknown claude model alias: ${model} (${[...CLAUDE_ALIASES].join("|")} or claude-*)`;
  }
  return `unknown tool: ${tool}`;
}

export async function doctor(root: string): Promise<number> {
  const ok: string[] = [];
  const problems: string[] = [];

  let opencodePresent = false;
  let claudePresent = false;
  for (const cli of ["opencode", "claude"]) {
    const r = await run([cli, "--version"], 15000);
    if (r.code === 0) {
      ok.push(`${cli}: present (${r.out.split("\n")[0]})`);
      if (cli === "opencode") opencodePresent = true;
      else claudePresent = true;
    } else problems.push(`${cli}: could not run (exit ${r.code})`);
  }

  let cfg: HarnessConfig | null = null;
  try {
    cfg = await loadConfig(root);
    ok.push("config.yaml: valid");
  } catch (e) {
    problems.push(`config.yaml: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const wf of ["FIX", "FEATURE", "ASK"]) {
    try {
      await loadWorkflow(root, wf);
      ok.push(`workflow ${wf}: valid`);
    } catch (e) {
      problems.push(`workflow ${wf}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const opencodeModels = new Set<string>();
  const modelsRun = await run(["opencode", "models"], 30000);
  for (const line of modelsRun.out.split("\n")) {
    const m = line.trim();
    if (m) opencodeModels.add(m);
  }

  if (cfg) {
    const seen = new Set<string>();
    let claudeRoleCount = 0;
    for (const e of EFFORTS) {
      for (const r of ROLES) {
        const res = cfg.efforts[e][r];
        if (res.tool === "claude") claudeRoleCount++;
        const key = `${res.tool}:${res.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const problem = checkModel(res.tool, res.model ?? "", opencodeModels);
        if (problem) problems.push(`efforts.${e}.${r}: ${problem}`);
        else ok.push(`efforts.${e}.${r}: ${res.tool} ${res.model} OK`);
      }
    }
    const guidance: string[] = [];
    if (claudeRoleCount && !claudePresent) {
      guidance.push(
        `config uses claude for ${claudeRoleCount} role mapping(s) but the 'claude' CLI is not available. ` +
          `If you don't want to use Claude Code, set the roles you don't need to ` +
          `tool: opencode in config.yaml (or override per step in the workflow).`,
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
