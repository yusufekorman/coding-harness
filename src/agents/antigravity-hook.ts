#!/usr/bin/env bun
// PreToolUse permission gate for `agy` (Antigravity CLI).
//
// Installed by the harness into ~/.gemini/antigravity-cli/hooks.json so it only
// affects `agy` runs. When the HARNESS_AGY_* env vars are absent it reproduces
// agy's default `request-review` behaviour (allow reads / workspace writes, ask
// for the rest), so normal interactive use is unaffected.
//
// Contract (stdin <- JSON, stdout -> JSON):
//   in:  { toolCall: { name, args }, workspacePaths: string[], ... }
//   out: { decision: "allow" | "deny" | "ask", reason?, permissionOverrides? }

import { readFileSync } from "node:fs";
import { connect } from "node:net";

const TOOL_CATEGORY: Record<string, string> = {
  run_command: "bash",
  write_to_file: "edit",
  create_file: "edit",
  edit_file: "edit",
  read_file: "read",
  read_url: "webfetch",
  execute_url: "webfetch",
  ask_permission: "question",
};

function categoryFor(name: string): string {
  const direct = TOOL_CATEGORY[name];
  if (direct) return direct;
  if (/command|terminal|shell/.test(name)) return "bash";
  if (/write|edit|create|patch|delete|remove|move/.test(name)) return "edit";
  if (/read|view|grep|glob|list|search/.test(name)) return "read";
  if (/url|browser|fetch|web/.test(name)) return "webfetch";
  return "ask";
}

function pathsIn(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["FilePath", "filePath", "path", "Path", "target", "Target"]) {
    const v = args[k];
    if (typeof v === "string" && v) out.push(v);
  }
  return out;
}

function patternsFor(name: string, args: Record<string, unknown>): string[] {
  if (name === "run_command") {
    const cmd = args.CommandLine ?? args.command ?? args.cmd;
    return typeof cmd === "string" && cmd ? [cmd] : [];
  }
  return pathsIn(args);
}

function withinWorkspace(path: string, workspacePaths: string[]): boolean {
  if (!workspacePaths.length) return false;
  return workspacePaths.some((w) => path === w || path.startsWith(w.replace(/\/$/, "") + "/"));
}

function respond(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function requestPermission(sockPath: string, req: unknown): Promise<string> {
  return new Promise((resolve) => {
    let socket: ReturnType<typeof connect> | null = null;
    const finish = (reply: string) => {
      if (socket) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      resolve(reply);
    };
    const timer = setTimeout(() => finish("reject"), 120_000);
    try {
      socket = connect(sockPath);
    } catch {
      clearTimeout(timer);
      resolve("reject");
      return;
    }
    let buf = "";
    socket.on("connect", () => socket?.write(JSON.stringify(req) + "\n"));
    socket.on("data", (d: Buffer) => {
      buf += d.toString();
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      clearTimeout(timer);
      try {
        const line = buf.slice(0, idx).trim();
        const parsed = JSON.parse(line) as { reply?: string };
        finish(parsed.reply ?? "reject");
      } catch {
        finish("reject");
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      finish("reject");
    });
  });
}

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = await new Response(process.stdin as unknown as ReadableStream<Uint8Array>).text();
  } catch {
    respond({ decision: "ask" });
    return;
  }

  let payload: {
    toolCall?: { name?: string; args?: Record<string, unknown> };
    workspacePaths?: string[];
  };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    respond({ decision: "ask" });
    return;
  }

  const name = payload.toolCall?.name ?? "";
  const args = payload.toolCall?.args ?? {};
  const workspacePaths = payload.workspacePaths ?? [];
  const category = categoryFor(name);

  // Not running under the harness -> reproduce agy's default request-review
  // behaviour and stay out of the way.
  const policyPath = process.env.HARNESS_AGY_POLICY;
  if (!policyPath) {
    if (category === "read") {
      respond({ decision: "allow" });
    } else if (category === "edit" && pathsIn(args).every((p) => withinWorkspace(p, workspacePaths))) {
      respond({ decision: "allow" });
    } else {
      respond({ decision: "ask" });
    }
    return;
  }
  if (process.env.HARNESS_AGY_SKIP === "1") {
    respond({ decision: "allow" });
    return;
  }

  let policy: Record<string, string> = {};
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, string>;
  } catch {
    /* empty policy */
  }

  const action = policy[category] ?? "ask";
  if (action === "allow") {
    respond({ decision: "allow" });
    return;
  }
  if (action === "deny") {
    respond({ decision: "deny", reason: `blocked by harness policy (${category})` });
    return;
  }

  const sockPath = process.env.HARNESS_AGY_SOCKET;
  if (!sockPath) {
    respond({ decision: "ask" });
    return;
  }

  const reply = await requestPermission(sockPath, {
    id: `${Date.now()}-${name}`,
    permission: category === "ask" ? name : category,
    patterns: patternsFor(name, args),
  });
  if (reply === "reject") {
    respond({ decision: "deny", reason: "rejected by orchestrator" });
    return;
  }
  respond({ decision: "allow" });
}

void main();
