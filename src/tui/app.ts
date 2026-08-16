import { basename, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import type { Decision, Effort, HarnessConfig, RunEvent, Step, StepContext, Workflow } from "../types";
import { loadConfig } from "../config";
import { loadWorkflow } from "../workflow";
import { runWorkflow, AbortError, type RunHooks } from "../run";
import { abortCurrent } from "../agents/types";
import { createRunLogger, runsDir, type RunLogger } from "../logger";
import { saveState } from "../state";
import { redact } from "../redact";
import * as term from "./term";
import { mdToText, wrap } from "./markdown";

type Phase = "workflow" | "effort" | "task" | "run" | "summary" | "error";

interface PickerItem {
  label: string;
  desc: string;
}

interface StepState {
  step: Step;
  status: "pending" | "running" | "done" | "failed";
}

const WORKFLOW_IDS = ["FIX", "FEATURE", "ASK"];
const EFFORTS: Effort[] = ["medium", "high"];

let cfg: HarnessConfig;
let workdir = "";
let phase: Phase = "workflow";
let sel = 0;
let pickerTitle = "";
let pickerItems: PickerItem[] = [];
let taskInput = "";
let task = "";
let workflow: Workflow | null = null;
let effort: Effort = "medium";
let stepStates: StepState[] = [];
let runningIdx = -1;
let log: string[] = [];
let promptText = "";
let promptValue = "";
let summaryText = "";
let errorText = "";
let spinnerTick = 0;
let quitRequested = false;
let watcherActive = false;
let runLogger: RunLogger | null = null;
let totalCost = 0;
let totalTokens = 0;

function workflowItems(): PickerItem[] {
  return [
    { label: "FIX", desc: "Hatayı teşhis et, düzelt, doğrula, raporla" },
    { label: "FEATURE", desc: "Yeni özelliği uçtan uca geliştir" },
    { label: "ASK", desc: "Salt okunur araştırma ve cevap" },
  ];
}

function effortItems(): PickerItem[] {
  return [
    { label: "medium", desc: "sonnet(high) · deepseek(medium)" },
    { label: "high", desc: "opus(medium) · deepseek(high)" },
  ];
}

// --- rendering ---

function box(title: string, lines: string[], w: number, h: number): string[] {
  const inner = Math.max(0, w - 2);
  const titleLen = term.stripAnsi(title).length;
  const top =
    term.BOX.tl + " " + title + term.BOX.h.repeat(Math.max(0, inner - titleLen - 1)) + term.BOX.tr;
  const body = lines
    .slice(0, h - 2)
    .map((l) => term.BOX.v + term.pad(term.cutVisible(l, inner), inner) + term.BOX.v);
  while (body.length < h - 2) body.push(term.BOX.v + " ".repeat(inner) + term.BOX.v);
  const bottom = term.BOX.bl + term.BOX.h.repeat(inner) + term.BOX.br;
  return [top, ...body, bottom];
}

function pickerContent(c: string[]): void {
  c.push(term.bold(pickerTitle));
  c.push("");
  pickerItems.forEach((it, i) => {
    const marker = i === sel ? ">" : " ";
    const label = i === sel ? term.cyan(term.bold(it.label)) : it.label;
    c.push(`  ${marker} ${label}   ${term.dim(it.desc)}`);
  });
  c.push("");
  c.push(term.dim("↑/↓ seç · Enter onayla · q/esc çıkış"));
}

function taskContent(c: string[], w: number): void {
  c.push(term.bold("Görev"));
  c.push(term.dim(`çalışma dizini: ${workdir}`));
  c.push("");
  const limit = Math.max(10, w - 6);
  let shown = taskInput;
  if (shown.length > limit) shown = "…" + shown.slice(-(limit - 1));
  c.push("  " + shown + (term.COLOR ? term.cyan("▌") : "|"));
  c.push("");
  c.push(term.dim("Enter çalıştır · q/esc çıkış"));
}

function runContent(c: string[], w: number, h: number): void {
  const spin = term.SPIN[spinnerTick % term.SPIN.length];
  const wf = workflow;
  c.push(
    term.dim(
      `${wf?.id ?? ""}${wf?.name ? " · " + wf.name : ""}  ·  effort ${effort}  ·  ${term.cutVisible(
        task,
        Math.max(10, w - 40),
      )}`,
    ),
  );
  c.push("");
  for (const s of stepStates) {
    let g: string;
    if (s.status === "done") g = term.green("✓");
    else if (s.status === "failed") g = term.red("✗");
    else if (s.status === "running") g = term.yellow(spin);
    else g = term.gray("·");
    c.push(`  ${g}  ${s.step.id}${s.step.name ? term.dim(" · " + s.step.name) : ""}`);
  }
  c.push("");

  if (promptText) {
    for (const l of wrap(mdToText(promptText), w - 4)) {
      c.push(term.bold(term.yellow("SORU: ")) + l);
    }
    c.push("> " + term.cutVisible(promptValue, w - 4) + (term.COLOR ? term.cyan("▌") : "|"));
  } else {
    const fixed = 4 + stepStates.length + 1;
    const budget = Math.max(0, h - 2 - fixed);
    const flat: string[] = [];
    for (const l of log.slice(-200)) flat.push(...wrap(mdToText(l), w - 4));
    for (const l of flat.slice(-budget)) c.push(term.gray(l));
    c.push(term.dim("q çıkış · çıktı canlı akar"));
  }
}

function summaryContent(c: string[], w: number, h: number): void {
  c.push(term.bold("Tamamlandı"));
  if (totalCost > 0) {
    c.push(term.dim(`toplam maliyet: $${totalCost.toFixed(4)}${totalTokens ? ` · ${totalTokens} token` : ""}`));
  }
  c.push("");
  const budget = Math.max(1, h - 6 - (totalCost > 0 ? 1 : 0));
  for (const l of wrap(mdToText(summaryText), w - 4).slice(0, budget)) c.push(l);
  c.push("");
  c.push(term.dim("Enter/q çıkış"));
}

function errorContent(c: string[]): void {
  c.push(term.bold(term.red("Durduruldu")));
  c.push("");
  c.push(errorText);
  c.push("");
  c.push(term.dim("Enter/q çıkış"));
}

function draw(): void {
  const { w, h } = term.dims();
  const content: string[] = [];
  switch (phase) {
    case "workflow":
    case "effort":
      pickerContent(content);
      break;
    case "task":
      taskContent(content, w);
      break;
    case "run":
      runContent(content, w, h);
      break;
    case "summary":
      summaryContent(content, w, h);
      break;
    case "error":
      errorContent(content);
      break;
  }
  term.frame(box(term.bold("coding-harness"), content, w, h));
}

// --- input helpers ---

async function pick(title: string, items: PickerItem[]): Promise<number> {
  pickerTitle = title;
  pickerItems = items;
  sel = 0;
  draw();
  while (true) {
    const k = await term.nextKey();
    if (k.type === "up") {
      sel = (sel - 1 + items.length) % items.length;
      draw();
    } else if (k.type === "down") {
      sel = (sel + 1) % items.length;
      draw();
    } else if (k.type === "enter") {
      return sel;
    } else if (k.type === "esc" || k.type === "ctrl-c" || (k.type === "char" && k.char === "q")) {
      throw new AbortError("iptal");
    }
  }
}

async function inputTask(): Promise<string> {
  taskInput = "";
  draw();
  while (true) {
    const k = await term.nextKey();
    if (k.type === "enter") {
      const v = taskInput.trim();
      task = v;
      return v;
    } else if (k.type === "backspace") {
      taskInput = taskInput.slice(0, -1);
      draw();
    } else if (k.type === "char") {
      taskInput += k.char;
      draw();
    } else if (k.type === "esc" || k.type === "ctrl-c") {
      throw new AbortError("iptal");
    }
  }
}

async function askUser(question: string): Promise<string> {
  stopWatcher();
  promptText = question;
  promptValue = "";
  draw();
  let result = "";
  while (true) {
    const k = await term.nextKey();
    if (k.type === "enter") {
      result = promptValue;
      break;
    } else if (k.type === "backspace") {
      promptValue = promptValue.slice(0, -1);
      draw();
    } else if (k.type === "char") {
      promptValue += k.char;
      draw();
    } else if (k.type === "esc" || k.type === "ctrl-c") {
      result = "";
      break;
    }
  }
  promptText = "";
  promptValue = "";
  startWatcher();
  draw();
  return result;
}

async function waitExitKey(): Promise<void> {
  while (true) {
    const k = await term.nextKey();
    if (k.type === "enter" || k.type === "esc" || k.type === "ctrl-c" || (k.type === "char" && k.char === "q")) {
      return;
    }
  }
}

function logLine(line: string): void {
  for (const l of redact(line).split("\n")) if (l) log.push(l);
  if (log.length > 2000) log = log.slice(log.length - 2000);
}

function startWatcher(): void {
  if (watcherActive) return;
  watcherActive = true;
  void (async () => {
    while (watcherActive) {
      const k = await term.nextKey();
      if (!watcherActive) break;
      if (k.type === "ctrl-c" || (k.type === "char" && k.char === "q")) {
        quitRequested = true;
        abortCurrent();
        draw();
      }
    }
  })();
}

function stopWatcher(): void {
  watcherActive = false;
  term.flushKeys();
}

// --- hooks ---

const hooks: RunHooks = {
  onStepStart: (step, i, _total, label) => {
    runningIdx = i;
    stepStates[i].status = "running";
    logLine(`${step.id} — ${label}`);
    draw();
  },
  onOutput: (chunk) => {
    logLine(chunk);
    draw();
  },
  onStepEnd: (step, result) => {
    if (quitRequested) throw new AbortError("kullanıcı iptal etti");
    if (runningIdx >= 0) stepStates[runningIdx].status = result.ok ? "done" : "failed";
    if (result.interruption) logLine(`⚠ ${result.interruption.kind}: ${result.interruption.message}`);
    draw();
  },
  onDecision: (step, d: Decision) => {
    logLine(`→ orchestrator: ${d.action}${d.reason ? " (" + d.reason + ")" : ""}`);
    draw();
  },
  onEvent: (evt: RunEvent) => {
    if (!runLogger) return;
    runLogger.onEvent(evt);
    if (evt.type === "progress" && workflow) {
      saveState(runLogger.dir, {
        runId: basename(runLogger.dir),
        workflow: workflow.id,
        task,
        effort,
        workdir,
        stepIndex: evt.index + 1,
        values: evt.values,
      });
    }
    if (evt.type === "step_end") {
      totalCost += evt.costUsd ?? 0;
      totalTokens = evt.tokens ?? totalTokens;
    }
  },
  ask: askUser,
};

// --- entry ---

export async function runTui(workdirArg: string, preselectEffort?: Effort): Promise<void> {
  if (!stdout.isTTY || !stdin.isTTY) {
    throw new Error("TUI bir terminal gerektirir (stdout/stdin TTY değil)");
  }

  const root = resolve(import.meta.dir, "..", "..");
  cfg = await loadConfig(root);
  workdir = workdirArg;

  let spinner: ReturnType<typeof setInterval> | undefined;
  const startSpinner = () => {
    if (!spinner) {
      spinner = setInterval(() => {
        spinnerTick++;
        if (phase === "run") draw();
      }, 80);
    }
  };
  const stopSpinner = () => {
    if (spinner) {
      clearInterval(spinner);
      spinner = undefined;
    }
  };

  term.enterAlt();
  term.enableRaw();

  try {
    phase = "workflow";
    const wi = await pick("Workflow", workflowItems());
    workflow = await loadWorkflow(root, WORKFLOW_IDS[wi]);

    if (preselectEffort) {
      effort = preselectEffort;
    } else {
      phase = "effort";
      effort = EFFORTS[await pick("Effort", effortItems())];
    }

    phase = "task";
    const t = await inputTask();
    if (!t) throw new AbortError("görev boş");

    phase = "run";
    stepStates = workflow.steps.map((s) => ({ step: s, status: "pending" as const }));
    runningIdx = -1;
    log = [];
    quitRequested = false;
    promptText = "";
    promptValue = "";
    totalCost = 0;
    totalTokens = 0;
    runLogger = createRunLogger(runsDir(), workflow.id);
    logLine(`run: ${runLogger.dir}`);
    startSpinner();
    startWatcher();

    const ctx: StepContext = { task: t, workdir, effort, workflow, values: {} };
    const values = await runWorkflow(cfg, ctx, hooks);

    stopSpinner();
    stopWatcher();

    const last = workflow.steps[workflow.steps.length - 1];
    summaryText = values[last.captures ?? last.id] ?? "";
    runLogger.finalize(summaryText);
    runLogger = null;
    phase = "summary";
    draw();
    await waitExitKey();
  } catch (err) {
    stopSpinner();
    stopWatcher();
    if (runLogger) {
      runLogger.onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
      runLogger.finalize("");
      runLogger = null;
    }
    if (err instanceof AbortError) {
      errorText = `İptal: ${err.message}`;
    } else {
      errorText = `Hata: ${err instanceof Error ? err.message : String(err)}`;
    }
    phase = "error";
    draw();
    await waitExitKey();
  } finally {
    stopSpinner();
    term.disableRaw();
    term.leaveAlt();
  }
}
