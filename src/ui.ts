import { createInterface } from "node:readline/promises";

export function log(msg: string): void {
  process.stderr.write(`[harness] ${msg}\n`);
}

export function step(msg: string): void {
  process.stderr.write(`[harness]   ${msg}\n`);
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n[harness] SORU: ${question}\n[harness] Cevabın (boş bırakırsan abort): `,
    );
    return answer.trim();
  } finally {
    rl.close();
  }
}
