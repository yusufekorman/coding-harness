import type { Decision, HarnessConfig, Interruption, Step, StepContext } from "./types";
import { resolveRole } from "./config";
import { runAgent, type AgentOptions, type PermissionAsk, type PermissionReply, type QuestionAsk } from "./agents";
import { extractJson } from "./json";

const MAX_CONTEXT = 6000;

function truncate(s: string, n = MAX_CONTEXT): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "\n...[kesildi]";
}

/** Orkestratörün kendi karar çağrısı: araç kullanmasın, ask/izin asmasın */
function decisionAgentOpts(cfg: HarnessConfig, ctx: StepContext, prompt: string): AgentOptions {
  const role = resolveRole(cfg, ctx.effort, "orchestrator");
  return {
    tool: role.tool,
    model: role.model,
    variant: role.variant,
    effort: role.effort,
    permission: "plan",
    prompt,
    workdir: ctx.workdir,
    permissions: {
      read: "allow",
      grep: "allow",
      glob: "allow",
      list: "allow",
      lsp: "allow",
      edit: "deny",
      bash: "deny",
      task: "deny",
      webfetch: "deny",
      websearch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
      question: "deny",
    },
    onPermission: async () => "reject",
    onQuestion: async () => null,
  };
}

function buildPrompt(
  ctx: StepContext,
  step: Step,
  output: string,
  interruption: Interruption | undefined,
  retriesUsed: number,
): string {
  const lines = [
    "Sen bir görev orkestratörüsün. Bir kodlama workflow'unun adımı yürütüldü; sonucu değerlendir ve tek bir JSON karar nesnesi döndür.",
    "",
    `Orijinal görev: ${ctx.task}`,
    `Mevcut adım: ${step.id}${step.name ? " — " + step.name : ""}`,
    `Adım talimatı: ${step.prompt}`,
    "",
    "Ajan çıktısı:",
    "---",
    truncate(output || "(boş)"),
    "---",
  ];

  if (interruption) {
    lines.push("", `Tespit edilen interruption: ${interruption.kind} — ${truncate(interruption.message, 1000)}`);
  }

  lines.push(
    "",
    `Bu adım için kullanılan tekrar sayısı: ${retriesUsed}`,
    "",
    "Sadece şu JSON'u döndür (başka metin yazma, araç kullanma):",
    JSON.stringify({
      action: "complete | answer | retry | escalate | abort",
      response: "answer için: ajanın sorusuna verilecek cevap; escalate için: kullanıcıya sorulacak soru",
      instruction: "retry için: ajanın adımı tekrar yaparken izleyeceği ek talimat",
      reason: "kısa gerekçe",
    }),
    "",
    "Kurallar:",
    "- Adım başarıyla tamamlandıysa action=complete.",
    "- Ajan bir soru sorduysa veya eksik bilgi varsa ve cevabı biliyorsan action=answer (response=cevap).",
    "- Cevabı sen de bilmiyorsan ve gerçekten kullanıcıya sorulması gerekiyorsa action=escalate (response=soru).",
    "- Adım başarısızsa ya da farklı yaklaşım gerekiyorsa action=retry (instruction=talimat).",
    "- Görev imkânsızsa action=abort.",
    "- Sadece gerektiğinde escalate et; kolay kararlar için answer/retry kullan.",
  );
  return lines.join("\n");
}

function parseDecision(text: string): Decision {
  const json = extractJson(text) as Record<string, unknown> | null;
  if (json) {
    const action = json.action;
    if (["complete", "answer", "retry", "escalate", "abort"].includes(String(action))) {
      return {
        action: String(action) as Decision["action"],
        response: typeof json.response === "string" ? json.response : undefined,
        instruction: typeof json.instruction === "string" ? json.instruction : undefined,
        reason: typeof json.reason === "string" ? json.reason : undefined,
      };
    }
  }

  const lower = text.toLowerCase();
  if (lower.includes("abort")) return { action: "abort" };
  if (lower.includes("escalate")) return { action: "escalate", response: text };
  // Karar JSON'u üretilemedi -> sessizce "tamamlandı" demek tehlikeli; kullanıcıya ilet.
  return {
    action: "escalate",
    response: `Orkestratör karar üretemedi. Ham çıktı:\n${text.trim() || "(boş)"}`,
    reason: "karar parse edilemedi",
  };
}

export async function decide(
  cfg: HarnessConfig,
  ctx: StepContext,
  step: Step,
  output: string,
  interruption: Interruption | undefined,
  retriesUsed: number,
): Promise<Decision> {
  const prompt = buildPrompt(ctx, step, output, interruption, retriesUsed);
  const result = await runAgent(decisionAgentOpts(cfg, ctx, prompt));

  if (!result.output.trim() || result.interruption) {
    return {
      action: "escalate",
      response: `Orkestratör ajan hata verdi: ${result.interruption?.message ?? "boş çıktı"}`,
      reason: "orkestratör hata verdi",
    };
  }

  return parseDecision(result.output);
}

export interface PermissionDecision {
  reply?: PermissionReply;
  escalate?: boolean;
  question?: string;
}

export async function decidePermission(
  cfg: HarnessConfig,
  ctx: StepContext,
  step: Step,
  ask: PermissionAsk,
): Promise<PermissionDecision> {
  const prompt = [
    "Sen bir görev orkestratörüsün. Bir kodlama ajanı bir izin istiyor. İzni değerlendir ve tek bir JSON nesnesi döndür.",
    "",
    `Orijinal görev: ${ctx.task}`,
    `Mevcut adım: ${step.id}${step.name ? " — " + step.name : ""}`,
    `İzin tipi: ${ask.permission}`,
    `Kalıplar: ${truncate((ask.patterns ?? []).join(", ") || "(yok)", 500)}`,
    "",
    "Sadece şu JSON'u döndür (araç kullanma):",
    JSON.stringify({ reply: "once | always | reject", reason: "kısa gerekçe" }),
    'ya da emin değilsen: {"escalate": true, "question": "kullanıcıya sorulacak soru"}',
    "",
    "Kurallar:",
    "- Güvenli/rutin bir izinse reply=once (veya her zaman için always).",
    "- Riskli/yıkıcı ise reply=reject.",
    "- Karar veremiyorsan escalate et.",
  ].join("\n");

  const result = await runAgent(decisionAgentOpts(cfg, ctx, prompt));
  const json = extractJson(result.output) as Record<string, unknown> | null;

  if (json?.escalate) {
    return { escalate: true, question: typeof json.question === "string" ? json.question : undefined };
  }
  if (json && ["once", "always", "reject"].includes(String(json.reply))) {
    return { reply: String(json.reply) as PermissionReply };
  }
  // bilinmiyorsa güvenli tarafta kal: reddet yerine kullanıcıya ilet
  return { escalate: true, question: `İzin isteği (${ask.permission}): ${(ask.patterns ?? []).join(", ")} — izin verilsin mi?` };
}

export interface QuestionDecision {
  answers?: string[];
  escalate?: boolean;
}

export async function decideQuestion(
  cfg: HarnessConfig,
  ctx: StepContext,
  step: Step,
  ask: QuestionAsk,
): Promise<QuestionDecision> {
  const qs = ask.questions
    .map((q, i) => {
      let s = `${i + 1}. ${q.question}`;
      if (q.options?.length) s += ` [seçenekler: ${q.options.map((o) => o.label).join(", ")}]`;
      return s;
    })
    .join("\n");

  const prompt = [
    "Sen bir görev orkestratörüsün. Bir kodlama ajanı kullanıcıya soru yöneltti. Cevabı biliyorsan cevapla, bilmiyorsan kullanıcıya ilet (escalate).",
    "",
    `Orijinal görev: ${ctx.task}`,
    `Mevcut adım: ${step.id}${step.name ? " — " + step.name : ""}`,
    "Ajanın soruları:",
    qs,
    "",
    "Sadece şu JSON'u döndür (araç kullanma):",
    JSON.stringify({ answers: ["soru1 cevabı", "soru2 cevabı"], reason: "kısa gerekçe" }),
    'ya da: {"escalate": true}',
    "",
    "Kurallar:",
    "- Her soru için bir cevap (answers dizisi, sırayla).",
    "- Cevaplardan emin değilsen escalate et; uydurma cevap yazma.",
  ].join("\n");

  const result = await runAgent(decisionAgentOpts(cfg, ctx, prompt));
  const json = extractJson(result.output) as Record<string, unknown> | null;

  if (json && Array.isArray(json.answers)) {
    return { answers: json.answers.map((a) => String(a)) };
  }
  if (json?.escalate) {
    return { escalate: true };
  }
  return { escalate: true };
}
