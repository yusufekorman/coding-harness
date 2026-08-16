import { mkdirSync } from "node:fs";
import type { Effort } from "./types";

export interface RunState {
  runId: string;
  workflow: string;
  task: string;
  effort: Effort;
  workdir: string;
  /** index of the next step (0-based) — i.e. the number of completed steps */
  stepIndex: number;
  values: Record<string, string>;
}

export function saveState(dir: string, state: RunState): void {
  mkdirSync(dir, { recursive: true });
  Bun.write(`${dir}/state.json`, JSON.stringify(state, null, 2));
}

export async function readState(runDir: string): Promise<RunState | null> {
  const f = Bun.file(`${runDir}/state.json`);
  if (!(await f.exists())) return null;
  try {
    return JSON.parse(await f.text()) as RunState;
  } catch {
    return null;
  }
}
