# Coding Harness

An orchestrator that runs `opencode` and `claude` (Claude Code) headless in the
background and executes your own workflows step by step.

You only say which workflow to use: `FIX`, `FEATURE`, or `ASK`. When a step hits an
interruption (error / permission denied / question), the **orchestrator LLM** decides
first; if it cannot decide, it escalates to you.

## Installation

```bash
bun install
ln -s "$PWD/src/index.ts" ~/.local/bin/harness   # global command (must be on PATH)
```

## Usage

### TUI (interactive)

```bash
harness .        # in the directory you want to work in
harness /project # or in a specific directory
```

Inside the TUI you pick a **workflow** (FIX/FEATURE/ASK), an **effort** level
(medium/high), and a **task** in sequence; the steps then run with live streaming
output. On escalation, the question is asked inside the TUI. Press `q` to quit.

### Headless

```bash
harness FIX "fix the login bug" --effort high
harness FEATURE "add a user profile page"
harness ASK "which auth method does this project use?"
```

- `--effort medium|high` (default `medium`) — selects the role/model matrix in
  `config.yaml`.
- `--dir <path>` — the project directory the agents work in (default: current dir).
- `--verbose, -v` — stream agent output in headless mode.
- `--ascii` — pure ASCII drawing in the TUI (instead of unicode).

## Flow

1. The workflow is loaded (`workflows/<ID>.yaml`).
2. Each step runs headless with an agent matching its role.
3. If a step ends with an interruption (or `review: true`), the **orchestrator**
   takes over:
   - `complete` — move to the next step
   - `answer` — the orchestrator answers the agent's question, the step re-runs
   - `retry` — the step re-runs with extra instructions
   - `escalate` — you are asked, and your answer is fed back
   - `abort` — stop

## Roles and models (`config.yaml`)

| role         | purpose             | medium                       | high                         |
|--------------|---------------------|------------------------------|------------------------------|
| orchestrator | decision mechanism  | opencode deepseek flash (variant medium) | opencode deepseek flash (variant high) |
| architect    | architecture / UI   | claude sonnet (effort high)  | claude opus (effort medium)  |
| coder        | writing code        | opencode deepseek pro (variant medium) | opencode deepseek pro (variant high) |

Freely editable via `config.yaml`. For `claude`, write aliases like `sonnet`/`opus`
in the model field; for `opencode`, write `provider/model` (listed with
`opencode models`).

The shipped `config.yaml` is only the **default** — you decide which tools and
models are used, or not used:

- Roles that map to `claude` only run Claude Code if the `claude` CLI is
  installed and configured. If you don't want Claude Code at all, point every
  role at `opencode` and it is never invoked (no separate "disable" flag exists,
  because you don't need one).
- The same applies to `opencode`: nothing forces it — every role is freely
  editable.
- A workflow's steps reference **roles**, not tools, so changing `config.yaml`
  is enough: you don't have to touch the workflows. You can still override
  `tool`/`model` per step (see below).

Two ready-to-paste examples (copy the whole `efforts:` block into your
`config.yaml` — the rest of the file stays as shipped):

**Only opencode — no Claude Code:**

```yaml
efforts:
  medium:
    orchestrator: { tool: opencode, model: opencode-go/deepseek-v4-flash, variant: medium }
    architect:    { tool: opencode, model: opencode-go/deepseek-v4-flash, variant: high }
    coder:        { tool: opencode, model: opencode-go/deepseek-v4-pro, variant: medium }
  high:
    orchestrator: { tool: opencode, model: opencode-go/deepseek-v4-flash, variant: high }
    architect:    { tool: opencode, model: opencode-go/deepseek-v4-pro, variant: high }
    coder:        { tool: opencode, model: opencode-go/deepseek-v4-pro, variant: high }
```

**Only Claude Code — no opencode:**

```yaml
efforts:
  medium:
    orchestrator: { tool: claude, model: sonnet, effort: medium }
    architect:    { tool: claude, model: sonnet, effort: high }
    coder:        { tool: claude, model: sonnet, effort: medium }
  high:
    orchestrator: { tool: claude, model: sonnet, effort: high }
    architect:    { tool: claude, model: opus, effort: medium }
    coder:        { tool: claude, model: opus, effort: high }
```

Note: each `efforts` entry (`medium` / `high`) **replaces** that whole bucket.
If you only override `medium`, the `high` bucket keeps its defaults — so for a
claude-free setup define both, and vice versa.

## Workflow file format

`workflows/<ID>.yaml`:

```yaml
id: FIX
name: Bug Fix
steps:
  - id: understand
    role: architect          # orchestrator | architect | coder
    permission: plan         # claude: plan|acceptEdits|dontAsk|bypassPermissions
    prompt: |
      Task: {{task}}
      Working directory: {{workdir}}
  - id: implement
    role: coder
    auto: true               # opencode --auto
    prompt: |
      Analysis: {{context.understand}}
      Task: {{task}}
```

Step fields:

- `id` (required), `name` (optional)
- `role`: `orchestrator` | `architect` | `coder`
- `tool` / `model`: override the role mapping per step (optional). Example — run just
  this one step on Claude Code while the rest of the workflow stays as configured:

  ```yaml
  - id: research
    role: architect
    tool: claude
    model: haiku
    prompt: |
      Task: {{task}}
  ```
- `permission`: claude permission-mode (per step; default: coder→`acceptEdits`, others→`plan`)
- `auto`: `--auto` for opencode (default: `true` for opencode + coder role)
- `variant` / `effort`: per-step reasoning override (optional)
- `prompt`: template; variables `{{task}}`, `{{workdir}}`, `{{effort}}`, `{{context.<stepId>}}`
- `captures`: the key the step output is stored under in context (default: `id`)
- `review`: whether the orchestrator evaluates this step's result (default `true`)
- `system`: extra system prompt for the agent (optional)

## Environment variables

- `HARNESS_STEP_TIMEOUT_MS` — per-step timeout (default 15 min).
- `HARNESS_LOG_DIR` — run log directory (default `~/.local/state/harness/runs`).
- `HARNESS_LOCK_DIR` — lock directory (default `~/.cache/harness`).

## Management commands

```bash
harness --doctor            # validate environment/config/models
harness --runs              # list recent runs
harness --resume <runId>    # resume from the step it left off
harness --version           # version
```

## Safety

`config.yaml` → `safety`:

- `autoApprove` (default `true`): when `false`, every permission category becomes `ask`
  (nothing is auto-approved; everything is asked of the orchestrator/user).
- `protectedDirs`: directories where write-capable steps are blocked. `$HOME` is only
  protected on an exact match (subproject directories remain free).

`config.yaml` → `permissions` (opencode, per category):

- `allow` — auto-approve, `ask` — ask orchestrator/user, `deny` — reject.
- Categories: `read`, `edit`, `bash`, `webfetch`, `external_directory`, `doom_loop`,
  `question`, `task`, `glob`, `grep`, `lsp`, `todowrite`, `codesearch`, `websearch`, `list`.

Also: only one harness runs at a time (lock file), agent processes run in a new process
group (the whole tree is killed on timeout/abort), and transient (no-output) errors are
retried with exponential backoff.

## Observability

Each run writes the following under `<logdir>/<ts>-<workflow>/`:

- `run.jsonl` — structured event stream (step, decision, cost, tokens, duration)
- `log.txt` — human-readable log (secrets are masked)
- `final.md` — final report
- `state.json` — context + completed step count for resume

## Full capability: live questions & permissions

- **Claude** (stdin full-duplex): `--brief` + `SendUserMessage` are caught in the same
  session and the orchestrator/user answer is written back as `tool_result` (no re-run).
- **opencode** (SDK, `@opencode-ai/sdk`): `question.asked`/`permission.asked` events are
  answered live in the same session via `question.reply`/`permission.reply`; the
  permission policy is applied from `config.yaml → permissions`. `variant` (reasoning
  effort) is passed through the SDK.
