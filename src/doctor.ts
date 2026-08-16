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
    return `opencode modeli bulunamadı: ${model}`;
  }
  if (tool === "claude") {
    if (CLAUDE_ALIASES.has(model) || model.startsWith("claude-")) return null;
    return `claude model alias'ı tanınmıyor: ${model} (${[...CLAUDE_ALIASES].join("|")} veya claude-*)`;
  }
  return `bilinmeyen tool: ${tool}`;
}

export async function doctor(root: string): Promise<number> {
  const ok: string[] = [];
  const problems: string[] = [];

  for (const cli of ["opencode", "claude"]) {
    const r = await run([cli, "--version"], 15000);
    if (r.code === 0) ok.push(`${cli}: mevcut (${r.out.split("\n")[0]})`);
    else problems.push(`${cli}: çalıştırılamadı (exit ${r.code})`);
  }

  let cfg: HarnessConfig | null = null;
  try {
    cfg = await loadConfig(root);
    ok.push("config.yaml: geçerli");
  } catch (e) {
    problems.push(`config.yaml: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const wf of ["FIX", "FEATURE", "ASK"]) {
    try {
      await loadWorkflow(root, wf);
      ok.push(`workflow ${wf}: geçerli`);
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
    for (const e of EFFORTS) {
      for (const r of ROLES) {
        const res = cfg.efforts[e][r];
        const key = `${res.tool}:${res.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const problem = checkModel(res.tool, res.model ?? "", opencodeModels);
        if (problem) problems.push(`efforts.${e}.${r}: ${problem}`);
        else ok.push(`efforts.${e}.${r}: ${res.tool} ${res.model} OK`);
      }
    }
  }

  process.stdout.write("== harness doctor ==\n");
  for (const o of ok) process.stdout.write(`  [OK] ${o}\n`);
  for (const p of problems) process.stdout.write(`  [!!] ${p}\n`);
  process.stdout.write(problems.length ? "Sonuç: sorunlar var\n" : "Sonuç: her şey hazır\n");

  return problems.length ? 1 : 0;
}
