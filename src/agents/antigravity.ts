import { join, dirname } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import type { Subprocess } from "bun";
import type { AgentResult, Interruption } from "../types";
import type { AgentOptions, PermissionAsk, PermissionReply } from "./types";
import { awaitExit, readLines, registerKill } from "./types";

const STEP_TIMEOUT_MS = Number(process.env.HARNESS_STEP_TIMEOUT_MS ?? 15 * 60 * 1000);
const HOOK_SCRIPT = join(import.meta.dir, "antigravity-hook.ts");

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

function printTimeout(): string {
  const ms = STEP_TIMEOUT_MS > 0 ? STEP_TIMEOUT_MS + 60_000 : 20 * 60 * 1000;
  return `${Math.ceil(ms / 1000)}s`;
}

interface Gate {
  dir: string;
  env: Record<string, string>;
  cleanup: () => void;
}

/**
 * Install (idempotently) the permission-gate hook into agy's global hooks file
 * (`~/.gemini/antigravity-cli/hooks.json`). The hook is inert when the
 * HARNESS_AGY_* env vars are absent, so normal `agy` use is unaffected. Best
 * effort: if we can't write it, agy still runs with its own defaults.
 */
let globalHookEnsured = false;
function ensureGlobalHook(): void {
  if (globalHookEnsured) return;
  globalHookEnsured = true;
  const home = process.env.HOME;
  if (!home) return;
  const hooksPath = join(home, ".gemini", "antigravity-cli", "hooks.json");
  const command = `${quote(process.execPath)} ${quote(HOOK_SCRIPT)}`;
  try {
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(hooksPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      /* missing or invalid — start fresh */
    }
    existing["harness-permission-gate"] = {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command, timeout: 600 }] },
      ],
    };
    mkdirSync(dirname(hooksPath), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify(existing, null, 2));
  } catch {
    /* best-effort */
  }
}

/**
 * Create a scratch dir holding the per-run permission policy and (for non-write
 * steps) a Unix socket the hook uses to round-trip "ask"-category permissions
 * back to the harness. Nothing is written into the user's project.
 */
function setupGate(opts: AgentOptions, isWrite: boolean): Gate {
  ensureGlobalHook();
  const dir = mkdtempSync(join(tmpdir(), "harness-agy-"));
  const policyPath = join(dir, "policy.json");
  writeFileSync(policyPath, JSON.stringify(opts.permissions ?? {}));

  const env: Record<string, string> = { HARNESS_AGY_POLICY: policyPath };

  let server: Server | null = null;
  if (isWrite) {
    env.HARNESS_AGY_SKIP = "1";
  } else if (opts.onPermission) {
    const sockPath = join(dir, "perm.sock");
    const always = new Map<string, PermissionReply>();
    server = createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          void (async () => {
            let reply: PermissionReply = "reject";
            try {
              const req = JSON.parse(line) as { id: string; permission: string; patterns?: string[] };
              const key = `${req.permission}\u0000${(req.patterns ?? []).join(",")}`;
              if (always.has(key)) {
                reply = always.get(key)!;
              } else if (opts.onPermission) {
                const ask: PermissionAsk = {
                  id: req.id ?? `${Date.now()}`,
                  permission: req.permission,
                  patterns: req.patterns ?? [],
                };
                reply = await opts.onPermission(ask);
                if (reply === "always") always.set(key, "once");
              }
            } catch {
              reply = "reject";
            }
            socket.write(JSON.stringify({ reply }) + "\n");
          })();
        }
      });
    });
    server.listen(sockPath);
    env.HARNESS_AGY_SOCKET = sockPath;
  }

  return {
    dir,
    env,
    cleanup: () => {
      if (server) {
        try {
          server.close();
        } catch {
          /* ignore */
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export async function runAntigravity(opts: AgentOptions): Promise<AgentResult> {
  const isWrite = opts.auto === true || (opts.permission != null && opts.permission !== "plan");
  const gate = setupGate(opts, isWrite);

  const args: string[] = ["-p", opts.prompt];
  args.push("--output-format", "stream-json");
  args.push("--add-dir", opts.workdir);
  args.push("--print-timeout", printTimeout());
  args.push("--mode", isWrite ? "accept-edits" : "plan");
  if (isWrite) args.push("--dangerously-skip-permissions");
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.system) args.push("--append-system-prompt", opts.system);

  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn<"ignore", "pipe", "pipe">({
      cmd: ["setsid", "agy", ...args],
      cwd: opts.workdir,
      env: Object.assign({}, process.env, gate.env) as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (e) {
    gate.cleanup();
    const code = e instanceof Error && "code" in e ? String((e as { code?: unknown }).code) : undefined;
    const detail = code && code !== "undefined" ? ` (${code})` : "";
    return {
      ok: false,
      output: "",
      exitCode: 127,
      interruption: {
        kind: "error",
        message:
          `tool 'antigravity' (agy) could not be started${detail}. ` +
          `If you don't want to use Antigravity CLI, set the roles you don't need to ` +
          `tool: opencode or tool: claude in config.yaml (or override per step in the workflow).`,
      },
    };
  }

  registerKill(() => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* not a group leader */
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });

  let text = "";
  let resultResponse = "";
  let resultStatus: string | undefined;
  let resultError: string | undefined;
  let usage: { total_tokens?: number } | undefined;
  let sawResult = false;
  const denials: string[] = [];

  const stdoutDone = readLines(proc.stdout, async (line) => {
    const l = line.trim();
    if (!l) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(l) as Record<string, unknown>;
    } catch {
      return;
    }
    if (ev.event === "step_update") {
      const sd = (ev.step_update ?? {}) as Record<string, unknown>;
      if (sd.state === "ACTIVE" && typeof sd.text_delta === "string" && sd.text_delta) {
        text += sd.text_delta;
        opts.onText?.(sd.text_delta);
      }
      const info = sd.tool_info as { error?: unknown } | undefined;
      if (info?.error) {
        const err = info.error;
        denials.push(
          typeof err === "string" ? err : ((err as Record<string, unknown>)?.message as string) ?? JSON.stringify(err),
        );
      }
    } else if (ev.event === "result") {
      sawResult = true;
      const r = (ev.result ?? {}) as Record<string, unknown>;
      resultStatus = typeof r.status === "string" ? r.status : undefined;
      resultResponse = typeof r.response === "string" ? r.response : "";
      resultError = typeof r.error === "string" ? r.error : undefined;
      usage = r.usage as { total_tokens?: number } | undefined;
    }
  });

  const exitCode = await awaitExit(proc);
  await stdoutDone;
  registerKill(null);
  const stderr = await new Response(proc.stderr).text();
  gate.cleanup();

  const output = (resultResponse || text).trim();
  let interruption: Interruption | undefined;

  if (exitCode !== 0) {
    interruption = {
      kind: "error",
      message: `antigravity error (exit ${exitCode}): ${stderr.trim() || resultError || "unknown"}`,
    };
  } else if (resultStatus && resultStatus !== "SUCCESS") {
    interruption = {
      kind: "error",
      message: resultError || `antigravity status ${resultStatus}`,
    };
  } else if (denials.length > 0) {
    interruption = { kind: "denied", message: `permission denied: ${denials.join(", ")}` };
  } else if (/no output produced|auto-denied|soft-den|permission check failed/i.test(stderr)) {
    interruption = {
      kind: "denied",
      message: stderr.trim() || "agent produced no output (tools were soft-denied in headless mode)",
    };
  }

  return {
    ok: !interruption,
    output,
    exitCode: interruption ? 1 : 0,
    interruption,
    tokens: usage?.total_tokens,
  };
}
