import { stdin, stdout } from "node:process";

export type KeyType =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "esc"
  | "backspace"
  | "tab"
  | "ctrl-c"
  | "char"
  | "pgup"
  | "pgdn"
  | "home"
  | "end"
  | "delete"
  | "unknown";

export interface Key {
  type: KeyType;
  char?: string;
}

export const ASCII = process.argv.includes("--ascii") || process.env.NO_UNICODE === "1";
export const COLOR = stdout.isTTY && process.env.NO_COLOR == null;

export const BOX = ASCII
  ? { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" }
  : { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

export const SPIN = ASCII
  ? ["|", "/", "-", "\\"]
  : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const ALT = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR_DOWN = "\x1b[J";

// --- raw mode + key reading ---

let inputBuf = "";
let keyQueue: Key[] = [];
let waiters: Array<(k: Key) => void> = [];
let rawEnabled = false;

function tryParse(): Key | null {
  if (inputBuf.length === 0) return null;
  const c0 = inputBuf[0];

  if (c0 === "\r" || c0 === "\n") {
    inputBuf = inputBuf.slice(1);
    return { type: "enter" };
  }
  if (c0 === "\t") {
    inputBuf = inputBuf.slice(1);
    return { type: "tab" };
  }
  if (c0 === "\x03") {
    inputBuf = inputBuf.slice(1);
    return { type: "ctrl-c" };
  }
  if (c0 === "\x7f" || c0 === "\x08") {
    inputBuf = inputBuf.slice(1);
    return { type: "backspace" };
  }
  if (c0 === "\x1b") {
    if (inputBuf.startsWith("\x1b[")) {
      const m = inputBuf.match(/^\x1b\[([0-9;]*)([A-Za-z~])/);
      if (m) {
        inputBuf = inputBuf.slice(m[0].length);
        const code = m[2];
        if (code === "A") return { type: "up" };
        if (code === "B") return { type: "down" };
        if (code === "C") return { type: "right" };
        if (code === "D") return { type: "left" };
        if (code === "H") return { type: "home" };
        if (code === "F") return { type: "end" };
        if (code === "~") {
          const n = m[1];
          if (n === "5") return { type: "pgup" };
          if (n === "6") return { type: "pgdn" };
          if (n === "3") return { type: "delete" };
          if (n === "1" || n === "7") return { type: "home" };
          if (n === "4" || n === "8") return { type: "end" };
          return { type: "unknown" };
        }
        return { type: "unknown" };
      }
      // incomplete escape sequence: wait for more bytes
      return null;
    }
    inputBuf = inputBuf.slice(1);
    return { type: "esc" };
  }

  inputBuf = inputBuf.slice(1);
  return { type: "char", char: c0 };
}

function onData(chunk: string): void {
  inputBuf += chunk;
  let k: Key | null;
  while ((k = tryParse())) {
    const w = waiters.shift();
    if (w) w(k);
    else keyQueue.push(k);
  }
}

export function enableRaw(): void {
  if (rawEnabled) return;
  rawEnabled = true;
  const s = stdin as unknown as { setRawMode?: (v: boolean) => void };
  if (typeof s.setRawMode === "function") s.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  stdin.on("data", onData);
}

export function disableRaw(): void {
  if (!rawEnabled) return;
  rawEnabled = false;
  const s = stdin as unknown as { setRawMode?: (v: boolean) => void };
  if (typeof s.setRawMode === "function") s.setRawMode(false);
  stdin.off("data", onData);
  stdin.pause();
}

export function nextKey(): Promise<Key> {
  if (keyQueue.length) return Promise.resolve(keyQueue.shift() as Key);
  return new Promise((res) => waiters.push(res));
}

export function flushKeys(): void {
  while (waiters.length) {
    const w = waiters.shift();
    if (w) w({ type: "unknown" });
  }
}

// --- terminal control ---

export function enterAlt(): void {
  stdout.write(ALT + HIDE);
}

export function leaveAlt(): void {
  stdout.write(SHOW + ALT_OFF);
}

export function dims(): { w: number; h: number } {
  return {
    w: stdout.columns || 80,
    h: stdout.rows || 24,
  };
}

// --- color ---

function color(code: number): (s: string) => string {
  return (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const red = color(31);
export const green = color(32);
export const yellow = color(33);
export const blue = color(34);
export const magenta = color(35);
export const cyan = color(36);
export const gray = color(90);
export const bold = color(1);
export const dim = color(2);

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - stripAnsi(s).length));
}

export function cutVisible(s: string, w: number): string {
  let out = "";
  let visible = 0;
  for (let i = 0; i < s.length; i++) {
    if (visible >= w) break;
    const ch = s[i];
    if (ch === "\x1b") {
      const end = s.indexOf("m", i);
      if (end !== -1) {
        out += s.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    out += ch;
    visible++;
  }
  return out;
}

// --- frame rendering ---

export function frame(lines: string[]): void {
  const { w } = dims();
  const out = lines.map((l) => cutVisible(l, w)).join("\r\n");
  stdout.write(HOME + out + "\r\n" + CLEAR_DOWN);
}
