import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "./types";
import { redact } from "./redact";

export function runsDir(): string {
  return process.env.HARNESS_LOG_DIR ?? join(process.env.HOME ?? "/tmp", ".local", "state", "harness", "runs");
}

interface Sink {
  write?: (d: string) => unknown;
  flush?: () => unknown;
  end?: () => void;
}

export interface RunLogger {
  dir: string;
  onEvent(evt: RunEvent): void;
  finalize(finalText: string): void;
  isOpen(): boolean;
}

function writeLine(sink: Sink | null, text: string): void {
  if (!sink) return;
  try {
    sink.write?.(text + "\n");
    sink.flush?.();
  } catch {
    /* ignore */
  }
}

function humanLine(evt: RunEvent): string {
  switch (evt.type) {
    case "start":
      return `# run start: ${redact(evt.task)}\n# workflow=${evt.workflow} effort=${evt.effort} workdir=${evt.workdir}`;
    case "step_start":
      return `\n## step ${evt.index + 1}/${evt.total}: ${evt.id}${evt.name ? ` (${evt.name})` : ""} — ${evt.tool}${evt.model ? " " + evt.model : ""}${evt.effort ? ` effort=${evt.effort}` : ""}${evt.variant ? ` variant=${evt.variant}` : ""}`;
    case "output":
      return redact(evt.chunk.replace(/\n$/, ""));
    case "step_end":
      return `  [${evt.ok ? "ok" : "FAIL"}] ${evt.id} (${evt.durationMs}ms)${evt.interruption ? ` — ${evt.interruption}` : ""}${evt.costUsd ? ` — $${evt.costUsd.toFixed(4)}` : ""}`;
    case "decision":
      return `  orchestrator: ${evt.action}${evt.reason ? ` (${evt.reason})` : ""}`;
    case "question":
      return `  QUESTION: ${redact(evt.message)}`;
    case "progress":
      return `  -> context updated (${Object.keys(evt.values).length} keys)`;
    case "end":
      return "\n# run end";
    case "error":
      return `\n!! error: ${redact(evt.message)}`;
  }
}

export function createRunLogger(baseDir: string, workflowId: string, runDir?: string): RunLogger {
  const dir =
    runDir ??
    `${baseDir}/${new Date().toISOString().replace(/[:.]/g, "-")}-${workflowId.toLowerCase()}`;
  mkdirSync(dir, { recursive: true });

  const jsonl: Sink | null = Bun.file(`${dir}/run.jsonl`).writer();
  const log: Sink | null = Bun.file(`${dir}/log.txt`).writer();
  let open = true;

  return {
    dir,
    onEvent(evt: RunEvent) {
      if (!open) return;
      writeLine(jsonl, JSON.stringify({ ts: Date.now(), ...evt }));
      writeLine(log, humanLine(evt));
    },
    finalize(finalText: string) {
      if (!open) return;
      open = false;
      writeLine(log, `\n=== final ===\n${redact(finalText)}`);
      try {
        Bun.write(`${dir}/final.md`, finalText + "\n");
      } catch {
        /* ignore */
      }
      try {
        jsonl?.end?.();
        log?.end?.();
      } catch {
        /* ignore */
      }
    },
    isOpen() {
      return open;
    },
  };
}
