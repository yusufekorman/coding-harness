---
name: workflow-authoring
description: >-
  How to write custom workflows and configure the Coding Harness. Use when
  creating workflows/<ID>.yaml files, editing config.yaml role/model/tool
  mappings, adding a role, or wiring a new tool (opencode / claude / antigravity).
---

# Writing workflows & configuring the harness

The harness runs one of your workflows (`workflows/<ID>.yaml`) against a project.
A workflow is a list of **steps**, each of which runs an agent headlessly and
hands its output to the next step. Which tool/model each step uses is decided by
**roles** in `config.yaml` — so you can change the tool/model matrix without
touching any workflow.

## Workflow files (`workflows/<ID>.yaml`)

Any `<ID>.yaml` (or `.yml`) in `workflows/` is runnable: `harness <ID> "task"`.

```yaml
id: FIX                      # required, uppercase by convention
name: Bug Fix                # optional
description: ...             # optional
steps:
  - id: understand           # required
    name: Understand the bug # optional
    role: architect          # orchestrator | architect | coder
    permission: plan         # see "Permission modes" below
    prompt: |
      Task: {{task}}
      Working directory: {{workdir}}
```

### Step fields

| field        | meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `id`         | required; used for `{{context.<id>}}` and as the default `captures` key |
| `name`       | optional display name                                                    |
| `role`       | `orchestrator` \| `architect` \| `coder` (default: `coder`)              |
| `tool`       | override the role's tool for this step: `opencode` \| `claude` \| `antigravity` |
| `model`      | override the role's model for this step                                  |
| `permission` | claude/antigravity permission mode (per step) — see below                |
| `auto`       | antigravity: auto-approve all tools for this step (`--dangerously-skip-permissions`) |
| `variant`    | per-step reasoning override for opencode (minimal…max)                   |
| `effort`     | per-step reasoning override for claude/antigravity (low…high)            |
| `system`     | extra system prompt for the agent                                         |
| `prompt`     | required; template, see below                                             |
| `captures`   | key the step output is stored under (default: `id`)                       |
| `review`     | orchestrator evaluates this step's result (default `true`)                |

### Prompt templating

`prompt` is rendered with these variables:

- `{{task}}` — the task text from the command line.
- `{{workdir}}` — the project directory.
- `{{effort}}` — the effort bucket (`medium` / `high`).
- `{{context.<stepId>}}` — the captured output of a previous step.

## Roles (`config.yaml` → `efforts`)

```yaml
efforts:
  medium:
    orchestrator: { tool: opencode, model: opencode-go/deepseek-v4-flash, variant: medium }
    architect:    { tool: claude,   model: sonnet,  effort: high }
    coder:        { tool: opencode, model: opencode-go/deepseek-v4-pro,  variant: medium }
  high:
    # ...same shape...
```

Each role maps to one `tool` + `model` (+ `variant` for opencode, `effort` for
claude/antigravity). Steps reference **roles**, so editing `config.yaml` is
enough to switch tools; a step can still override `tool`/`model`/`variant`/`effort`.

### Tool reference

- **opencode** — `model` is `provider/model` (list with `opencode models`);
  `variant` is `minimal|low|medium|high|max`; permission policy comes from
  `config.yaml → permissions` (categories below).
- **claude** — `model` is an alias (`sonnet`, `opus`, `haiku`, `fable`) or
  `claude-*`; `effort` is `low|medium|high|xhigh|max`; `permission` is a
  permission mode (`plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`).
- **antigravity** — `model` is a **slug** from `agy models`
  (`gemini-3.7-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, …);
  `effort` is `low|medium|high`; `permission` maps to agy's `--mode`
  (`plan` → `plan`, anything else → `accept-edits`).

## Permission modes & safety

### Per-step `permission`

- claude: `plan` \| `acceptEdits` \| `dontAsk` \| `bypassPermissions`.
- antigravity: `plan` → `--mode plan` (read-only); `acceptEdits` (and the
  coder default) → `--mode accept-edits` + `--dangerously-skip-permissions`
  (writes and commands auto-approved). `auto: true` has the same effect.

### `config.yaml → permissions` (opencode + antigravity categories)

```yaml
permissions:
  read: allow      # allow | ask | deny
  edit: allow
  bash: ask        # "ask" → antigravity round-trips to the orchestrator live
  webfetch: allow
```

Categories: `read`, `edit`, `bash`, `webfetch`, `websearch`, `grep`, `glob`,
`list`, `lsp`, `codesearch`, `task`, `external_directory`, `todowrite`,
`doom_loop`, `question`.

- opencode: enforced natively via the SDK (an `ask` fires a live prompt).
- antigravity: `allow`/`deny` are enforced deterministically; `ask` is answered
  live by the orchestrator (or the user) via a `PreToolUse` hook the harness
  installs at `~/.gemini/antigravity-cli/hooks.json`. Write/`auto` steps skip
  this and auto-approve everything.

### `config.yaml → safety`

```yaml
safety:
  autoApprove: true       # false → every permission category becomes "ask"
  protectedDirs: [ "$HOME", "/", "/etc" ]  # write steps refused here
```

## Environment variables

- `HARNESS_STEP_TIMEOUT_MS` — per-step timeout (default 15 min).
- `HARNESS_LOG_DIR` — run log directory (default `~/.local/state/harness/runs`).
- `HARNESS_LOCK_DIR` — lock directory (default `~/.cache/harness`).

## Example: antigravity-only `efforts`

Copy the whole `efforts:` block into `config.yaml`:

```yaml
efforts:
  medium:
    orchestrator: { tool: antigravity, model: gemini-3.7-flash-high, effort: low }
    architect:    { tool: antigravity, model: claude-sonnet-4-6, effort: high }
    coder:        { tool: antigravity, model: gemini-3.1-pro-high, effort: medium }
  high:
    orchestrator: { tool: antigravity, model: gemini-3.1-pro-high, effort: medium }
    architect:    { tool: antigravity, model: claude-sonnet-4-6, effort: high }
    coder:        { tool: antigravity, model: gemini-3.1-pro-high, effort: high }
```

## Validating

```bash
harness --doctor      # validates config.yaml, every workflow, and each tool's models
```

## Antigravity caveats

- Model names must be **slugs** (`agy models`), not display names.
- There is no live question backchannel in headless mode: an agent question is
  resolved by the orchestrator `answer`/`escalate` loop (a step re-run) rather
  than a live pause.
- `agy` does not report USD cost (`costUsd` is empty; token counts are captured).
- `doom_loop` and other opencode-only concepts have no antigravity analog.
