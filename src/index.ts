#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { basename, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { Effort, HarnessConfig, StepContext, Workflow } from "./types";
import { EFFORTS, loadConfig } from "./config";
import { loadWorkflow } from "./workflow";
import { runWorkflow, type RunHooks } from "./run";
import { ask, log, step } from "./ui";
import { acquireLock } from "./lock";
import { closeAgents } from "./agents";
import { createRunLogger, runsDir, type RunLogger } from "./logger";
import { readState, saveState } from "./state";
import { doctor } from "./doctor";

const WORKFLOW_IDS = new Set(["FIX", "FEATURE", "ASK"]);

function printHelp(): void {
  process.stdout.write(`Coding Harness — opencode / Claude Code workflow orchestrator

Usage:
  harness .                          → interactive TUI (runs in the current directory)
  harness <dir>                      → TUI, runs in the specified directory
  harness <WORKFLOW> "task" [...]    → run headless (FIX | FEATURE | ASK)
  harness --resume <runId>           → resume from where it left off
  harness --doctor                   → validate environment/config/models
  harness --runs                     → list recent runs

Options:
  --effort medium|high   select the role/model matrix in headless mode (default medium)
  --dir <dir>            project directory the agents work in
  --ascii                pure ASCII drawing in the TUI (instead of unicode)
  --verbose, -v          stream agent output in headless mode
  -V, --version          version
  -h, --help             help

Examples:
  harness .
  harness FIX "fix the login bug" --effort high
  harness ASK "which auth method does this project use?"
  harness --resume 2026-08-16T10-00-00-123Z-fix
`);
}

async function getVersion(root: string): Promise<string> {
  try {
    const pkg = JSON.parse(await Bun.file(`${root}/package.json`).text()) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function looksLikeDir(s: string): boolean {
  if (s === "." || s === "..") return true;
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("~")) {
    return true;
  }
  if (WORKFLOW_IDS.has(s.toUpperCase())) return false;
  return existsSync(s);
}

function listRuns(): void {
  const base = runsDir();
  let names: string[] = [];
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort()
      .reverse()
      .slice(0, 20);
  } catch {
    /* no dir */
  }
  if (!names.length) {
    process.stdout.write("(no saved runs)\n");
    return;
  }
  for (const n of names) process.stdout.write(`${n}\n`);
}

async function runAndLog(
  cfg: HarnessConfig,
  ctx: StepContext,
  logger: RunLogger,
  runDir: string,
  startIndex: number,
  verbose: boolean,
): Promise<Record<string, string>> {
  const workflow = ctx.workflow;

  const hooks: RunHooks = {
    onStepStart: (s, i, total, label) => {
      log(`\nstep ${i + 1}/${total}: ${s.id}${s.name ? " (" + s.name + ")" : ""}  [${label}]`);
    },
    onOutput: (chunk) => {
      if (verbose) process.stdout.write(chunk);
    },
    onStepEnd: (_s, r) => {
      if (r.interruption) step(`interruption (${r.interruption.kind}): ${r.interruption.message}`);
      else step(`ok (${r.output.length} chars)`);
    },
    onDecision: (_s, d) => {
      step(`orchestrator: ${d.action}${d.reason ? ` (${d.reason})` : ""}`);
    },
    onEvent: (evt) => {
      logger.onEvent(evt);
      if (evt.type === "progress") {
        saveState(runDir, {
          runId: basename(runDir),
          workflow: workflow.id,
          task: ctx.task,
          effort: ctx.effort,
          workdir: ctx.workdir,
          stepIndex: evt.index + 1,
          values: evt.values,
        });
      }
    },
    ask,
  };

  const values = await runWorkflow(cfg, ctx, hooks, startIndex);
  const lastStep = workflow.steps[workflow.steps.length - 1];
  const finalText = values[lastStep.captures ?? lastStep.id] ?? "";
  logger.finalize(finalText);

  log("\ncompleted. Final step output:");
  process.stdout.write(`\n${finalText}\n`);
  log(`run log: ${runDir}`);
  return values;
}

async function runHeadless(
  root: string,
  wfId: string,
  task: string,
  effort: Effort,
  workdir: string,
  verbose: boolean,
): Promise<void> {
  const cfg = await loadConfig(root);
  const workflow = await loadWorkflow(root, wfId);
  const logger = createRunLogger(runsDir(), workflow.id);

  log(`workflow: ${workflow.id}${workflow.name ? " — " + workflow.name : ""} | effort: ${effort}`);
  log(`task: ${task}`);
  log(`workdir: ${workdir}`);

  const ctx: StepContext = { task, workdir, effort, workflow, values: {} };
  await runAndLog(cfg, ctx, logger, logger.dir, 0, verbose);
}

async function resumeRun(root: string, runId: string): Promise<void> {
  const runDir = runId.startsWith("/") || runId.startsWith("./") ? runId : join(runsDir(), runId);
  const state = await readState(runDir);
  if (!state) {
    log(`resume state not found: ${runDir}`);
    process.exit(1);
  }
  const cfg = await loadConfig(root);
  const workflow: Workflow = await loadWorkflow(root, state.workflow);
  const logger = createRunLogger(runsDir(), workflow.id, runDir);
  const ctx: StepContext = {
    task: state.task,
    workdir: state.workdir,
    effort: state.effort,
    workflow,
    values: state.values,
  };

  log(`resume: ${workflow.id} | step ${Math.min(state.stepIndex + 1, workflow.steps.length)}/${workflow.steps.length} | ${state.task}`);
  await runAndLog(cfg, ctx, logger, runDir, state.stepIndex, false);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      effort: { type: "string" },
      dir: { type: "string" },
      help: { type: "boolean", short: "h" },
      ascii: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      version: { type: "boolean", short: "V" },
      doctor: { type: "boolean" },
      resume: { type: "string" },
      runs: { type: "boolean" },
    },
  });

  const root = resolve(import.meta.dir, "..");

  if (values.help) {
    printHelp();
    return;
  }
  if (values.version) {
    process.stdout.write(`harness ${await getVersion(root)}\n`);
    return;
  }
  if (values.doctor) {
    process.exit(await doctor(root));
  }
  if (values.runs) {
    listRuns();
    return;
  }
  if (values.resume) {
    await resumeRun(root, values.resume);
    return;
  }

  const release = acquireLock();
  try {
    const isTui =
      positionals.length === 0 ||
      (positionals.length === 1 && looksLikeDir(String(positionals[0])));

    if (isTui) {
      const dirArg = positionals.length === 1 ? String(positionals[0]) : ".";
      const workdir = resolve(values.dir ?? dirArg);
      const effort = EFFORTS.includes(values.effort as Effort) ? (values.effort as Effort) : undefined;
      const { runTui } = await import("./tui/app");
      await runTui(workdir, effort);
      return;
    }

    const wfId = String(positionals[0]).toUpperCase();
    const task = positionals.slice(1).join(" ").trim();
    if (!task) {
      log(`Task description is required. E.g. harness FIX "fix this bug"`);
      process.exit(1);
    }

    const workdir = resolve(values.dir ?? process.cwd());
    const cfg = await loadConfig(root);
    const effort = (values.effort ?? cfg.defaultEffort ?? "medium") as Effort;
    if (!EFFORTS.includes(effort)) {
      log(`Invalid effort: ${effort} (${EFFORTS.join("|")})`);
      process.exit(1);
    }

    await runHeadless(root, wfId, task, effort, workdir, values.verbose === true);
  } finally {
    closeAgents();
    release();
  }
}

process.on("exit", () => {
  closeAgents();
});

main().catch((err) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
