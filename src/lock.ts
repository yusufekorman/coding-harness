import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_DIR = process.env.HARNESS_LOCK_DIR ?? join(process.env.HOME ?? "/tmp", ".cache", "harness");
const STALE_MS = 24 * 60 * 60 * 1000;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(): () => void {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = join(LOCK_DIR, "run.lock");

  if (existsSync(lockPath)) {
    let stale = false;
    try {
      const data = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; ts?: number };
      if (!pidAlive(data.pid ?? 0) || (Date.now() - (data.ts ?? 0) > STALE_MS)) stale = true;
    } catch {
      stale = true;
    }
    if (stale) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* ignore */
      }
    } else {
      throw new Error(`another harness is already running (${lockPath}). Wait or remove the lock.`);
    }
  }

  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, ts: Date.now(), cmd: process.argv.slice(2).join(" ") }),
    { flag: "wx" },
  );

  return () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  };
}
