# Coding Harness

`opencode` ve `claude` (Claude Code) araçlarını arka planda headless çalıştırıp, kendi
yazdığın workflow'ları adım adım uygulayan bir orkestratör.

Sen sadece hangi workflow'un kullanılacağını söylersin: `FIX`, `FEATURE`, `ASK`.
Bir adımda interruption (hata / izin reddi / soru) olursa önce **orkestratör LLM** karar
verir; o da karar veremezse sana sorar.

## Kurulum

```bash
bun install
ln -s "$PWD/src/index.ts" ~/.local/bin/harness   # global komut (PATH'te olmalı)
```

## Kullanım

### TUI (etkileşimli)

```bash
harness .        # çalışacağın dizinde
harness /proje   # ya da belirli bir dizinde
```

TUI içinde sırayla **workflow** (FIX/FEATURE/ASK), **effort** (medium/high) ve **görev**
seçilir; ardından adımlar canlı akan çıktıyla çalışır. Escalation durumunda soru TUI
içinde sorulur. `q` ile çıkılır.

### Headless

```bash
harness FIX "login hatasını düzelt" --effort high
harness FEATURE "kullanıcı profili sayfası ekle"
harness ASK "bu proje hangi auth yöntemini kullanıyor?"
```

- `--effort medium|high` (varsayılan `medium`) — `config.yaml` içindeki rol/model matrisini seçer.
- `--dir <path>` — ajanların çalışacağı proje dizini (varsayılan: geçerli dizin).
- `--verbose, -v` — headless modda ajan çıktısını akıt.
- `--ascii` — TUI'de saf ASCII çizim (unicode yerine).

## Akış

1. Workflow yüklenir (`workflows/<ID>.yaml`).
2. Her adım, rolüne göre bir ajanla headless çalıştırılır.
3. Adım sonucunda interruption varsa (veya `review: true` ise) **orkestratör** devreye girer:
   - `complete` — sonraki adıma geç
   - `answer` — ajanın sorusuna orkestratör cevap verir, adım tekrar çalışır
   - `retry` — ek talimatla adım tekrar çalışır
   - `escalate` — sana sorulur, cevabın geri beslenir
   - `abort` — durdur

## Roller ve modeller (`config.yaml`)

| rol          | görev               | medium                    | high                        |
|--------------|---------------------|---------------------------|-----------------------------|
| orchestrator | karar mekanizması   | opencode deepseek flash (variant medium) | opencode deepseek flash (variant high) |
| architect    | mimari / UI tasarımı| claude sonnet (effort high)| claude opus (effort medium) |
| coder        | kod yazma           | opencode deepseek pro (variant medium)  | opencode deepseek pro (variant high) |

`config.yaml` içinden serbestçe düzenlenebilir. `claude` model alanına `sonnet`/`opus`
gibi takma adlar, `opencode` model alanına `provider/model` biçimi yazılır
(`opencode models` ile listelenir).

## Workflow dosya biçimi

`workflows/<ID>.yaml`:

```yaml
id: FIX
name: Bug Fix
steps:
  - id: understand
    role: architect          # orchestrator | architect | coder
    permission: plan         # claude: plan|acceptEdits|dontAsk|bypassPermissions
    prompt: |
      Görev: {{task}}
      Çalışma dizini: {{workdir}}
  - id: implement
    role: coder
    auto: true               # opencode --auto
    prompt: |
      Analiz: {{context.understand}}
      Görev: {{task}}
```

Adım alanları:

- `id` (zorunlu), `name` (opsiyonel)
- `role`: `orchestrator` | `architect` | `coder`
- `tool` / `model`: rol eşlemesini adım bazında ezmek için (opsiyonel)
- `permission`: claude permission-mode (adım bazında; varsayılan: coder→`acceptEdits`, diğerleri→`plan`)
- `auto`: opencode için `--auto` (varsayılan: opencode + coder rolünde `true`)
- `variant` / `effort`: adım bazında reasoning override (opsiyonel)
- `prompt`: şablon; değişkenler `{{task}}`, `{{workdir}}`, `{{effort}}`, `{{context.<stepId>}}`
- `captures`: çıktının context'e hangi anahtarla kaydedileceği (varsayılan `id`)
- `review`: orkestratör bu adımın sonucunu değerlendirsin mi (varsayılan `true`)
- `system`: ajan için ek sistem yönergesi (opsiyonel)

## Ortam değişkenleri

- `HARNESS_STEP_TIMEOUT_MS` — adım başına zaman aşımı (varsayılan 15 dk).
- `HARNESS_LOG_DIR` — çalıştırma log dizini (varsayılan `~/.local/state/harness/runs`).
- `HARNESS_LOCK_DIR` — kilit dizini (varsayılan `~/.cache/harness`).

## Yönetim komutları

```bash
harness --doctor            # ortam/config/model doğrulaması
harness --runs              # son çalıştırmaları listele
harness --resume <runId>    # kaldığı adımdan devam et
harness --version           # sürüm
```

## Güvenlik

`config.yaml` → `safety`:

- `autoApprove` (varsayılan `true`): `false` iken tüm izin kategorileri `ask` olur
  (hiçbir şey otomatik onaylanmaz, her şey orkestratöre/kullanıcıya sorulur).
- `protectedDirs`: yazma yetkili adımların çalışması engellenen dizinler. `$HOME` yalnızca
  birebir eşleşmede korunur (alt proje dizinleri serbesttir).

`config.yaml` → `permissions` (opencode, kategori bazlı):

- `allow` — otomatik onayla, `ask` — orkestratöre/kullanıcıya sor, `deny` — reddet.
- Kategoriler: `read`, `edit`, `bash`, `webfetch`, `external_directory`, `doom_loop`,
  `question`, `task`, `glob`, `grep`, `lsp`, `todowrite`, `codesearch`, `websearch`, `list`.

Ayrıca: yalnızca tek bir harness aynı anda çalışır (lock dosyası), ajan süreçleri yeni bir
process grubunda koşar (timeout/abort'ta tüm ağaç öldürülür), ve transient (çıktısız) hatalar
exponential backoff ile yeniden denenir.

## Gözlenebilirlik

Her çalıştırma `<logdir>/<ts>-<workflow>/` altında şunları yazar:

- `run.jsonl` — yapılandırılmış olay akışı (adım, karar, maliyet, token, süre)
- `log.txt` — insan-okunur log (sırlar maskelenir)
- `final.md` — son rapor
- `state.json` — resume için context + tamamlanan adım sayısı

## Tam kapasite: canlı soru & izin

- **Claude** (stdin full-duplex): `--brief` + `SendUserMessage` aynı session'da yakalanıp
  orkestratör/kullanıcı cevabı `tool_result` olarak geri yazılır (re-run yok).
- **opencode** (SDK, `@opencode-ai/sdk`): `question.asked`/`permission.asked` event'leri aynı
  session'da `question.reply`/`permission.reply` ile canlı yanıtlanır; izin politikası
  `config.yaml → permissions` ile uygulanır. `variant` (reasoning effort) SDK üzerinden geçer.
