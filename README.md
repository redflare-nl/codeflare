# CodeFlare

An agentic AI coding assistant for VS Code that runs a full **edit → diagnose → build/test → review → fix** loop against a **local** model (OpenAI-compatible server), **OpenAI**, or **Anthropic** — your choice, switchable per project.

CodeFlare's design principle: **the model is the brain; CodeFlare provides the eyes, hands, and feedback.** It offers capabilities (read/edit files, run commands, verify, debug) deterministically; the model decides which to use and in what order.

## Install

Download the latest `.vsix` from the [**Releases page**](../../releases) and install it with **Extensions → … → Install from VSIX…**, or:

```
code --install-extension codeflare-1.42.0.vsix
```

Then reload the window (**Developer: Reload Window**). See [RELEASES.md](RELEASES.md) for what's in each version. VSIX installations do not receive marketplace updates. Install downloaded releases manually; the optional source-based self-update workflow is described below.

---

## Providers

| Provider | Endpoint (default) | Notes |
|---|---|---|
| `local` (default) | `http://localhost:8001` | Any OpenAI-compatible server — VLLM, llama.cpp, Ollama, … The model name is **auto-discovered** from `/v1/models`, so you rarely have to type it. |
| `openai` | `https://api.openai.com` | Standard Chat Completions API. |
| `anthropic` | `https://api.anthropic.com` | Native Messages API (tool use, streaming) — not a shim. |

Set the provider, endpoint, model, and (for OpenAI/Anthropic) your API token in the **CodeFlare chat panel's settings**. Tokens are kept per-provider in VS Code's encrypted SecretStorage — never in `settings.json`, never committed.

## Quick start

1. Point CodeFlare at a backend:
   - **Local:** start your OpenAI-compatible server on `localhost:8001` (or set `codeflare.endpoint`). The model is auto-detected.
   - **OpenAI / Anthropic:** open the chat panel's settings, choose the provider, and paste your API token.
2. Open the chat: **`Ctrl+Shift+Q`** (`Cmd+Shift+Q` on macOS), or run **CodeFlare: Open Chat**.
3. Ask for something. In agent mode (on by default) it will explore the workspace, make edits, run the project's own checks, and fix what it broke before declaring done.

Check connectivity anytime with **CodeFlare: Check VLLM Health** (also the status-bar indicator) and your toolchain with **CodeFlare: Check Environment**.

## Missions, parallel agents and independent tests

The live footer above the chat input shows **Verkennen → Ontwerpen → Bouwen / herstellen → Controleren → Opleveren**. It displays the current activity, actual active-agent count, test status and any backward transition with its reason. Expand it for individual agents and phase history. Stop remains available while independent testing is running.

Two remembered controls apply to the next chat task; both default to **off**:

- **Autonoom uitvoeren** (`codeflare.autonomousMode`) asks the agent to establish acceptance criteria, research relevant unknowns, build and verify. It skips plan approval and includes the independent test stage. Existing command permissions, path restrictions and budgets still apply.
- **Tests schrijven en uitvoeren** (`codeflare.autoTest`) adds that test stage without enabling autonomous planning. A separate agent reads the original request and writes tests using the existing framework. The coordinator then executes the proposed test command and feeds failures into bounded repair attempts. A missing runner, empty suite or inconclusive execution remains incomplete. This requires agent mode, file editing and command execution to be enabled.

Set **Maximaal gelijktijdige subagents** in the chat settings' **Agents** tab, or use `codeflare.maxParallelAgents`: **1–32**, default **32**. All subagent submissions in a mission share one pool; extra work queues. The limit is a ceiling, not a target, and a settings change applies to the next mission. Agents have separate contexts but share workspace files; ownership checks and serialized mutations coordinate edits. Shell commands and integration checks run through the coordinator.

The current mission is saved with its phase, changed files, transitions and agent results. After a reload, interrupted work is shown as interrupted. Use **Hervatten** or **CodeFlare: Resume Mission** to continue after checking the current workspace state. Resumption is manual; interrupted tool calls are not automatically replayed. **CodeFlare: Save Mission and Reload** saves an idle mission before reloading; finish or stop active work first.

## Project knowledge and self-improvement

CodeFlare keeps three memory layers in VS Code's extension storage, outside the repository:

| Layer | Contents | Storage and scope |
|---|---|---|
| Working memory | Conversation, current mission, progress and agent results. | `workspaceState`, for this VS Code workspace. |
| Project memory | Project facts, task landscapes, experiments, observed failures and project skills. | `<storageUri>/memory/memory.md`, plus `memory/project/memory.sqlite` and `memory/project/artifacts/` under the same `storageUri`. |
| Agent memory | General procedures and their validation history, reusable across projects. | `<globalStorageUri>/memory/agent/memory.sqlite` and the adjacent `artifacts/` directory, shared by workspaces using this extension storage. |

The paths above refer to VS Code's `ExtensionContext` storage locations, outside both the repository and the extension installation. Self-updates replace the runtime without replacing these stores. Global memory is shared within the same VS Code profile and extension host; it does not automatically synchronize between computers, profiles or remote hosts. API keys remain in encrypted `SecretStorage`. **CodeFlare: Memory Status** checks storage readiness and reports skill and observation counts.

`remember` / `forget` manage project facts. `record_landscape` records acceptance criteria, sources, decisions and unknowns in project memory. `save_skill` and `try_skill` accept `scope: "project"` (the default) or `scope: "global"`; `list_skills` shows scope, version and validation state. Global procedures must omit project-specific details and secrets. New and revised skills start as candidates, and candidates do not enter automatic recall.

Skill records carry domains, provenance, version, successful/failed/inconclusive use counts, last validation and confidence. The controller records outcomes from observed mission execution and trusted test evidence after a declared `try_skill`; the model cannot assign its own confidence. A passing or failing mission is a proxy for skill usefulness, not proof that the skill caused the outcome. Counts apply to the current version; revisions reset that version's proof while retaining audit history. Inconclusive trials neither strengthen nor weaken confidence.

The confidence heuristic is `(successfulUses + 1) / (successfulUses + failedUses + 2) × 2^(-daysSinceLastSuccess / 90)`, or zero before the first successful use. This is a decaying evidence score, not a calibrated probability. For automatic reuse, a project skill needs successful evidence; a global skill needs successful trials from at least **two distinct missions in two workspaces**, a score of at least **0.70**, and fresh evidence within **90 days**. The latest conclusive trial must be successful, and a **24-hour cooldown** after a failure must have elapsed. Failed trials and aging can therefore remove a skill from automatic recall until it is revalidated.

The agent can develop its memory through these tools:

- **`promote_skill`** proposes generalized content from a validated project skill as a global candidate. Project proof is not copied into global use counts; cross-project trials are still required.
- **`save_skill`** corrects a procedure by creating a new candidate version. **`merge_skills`** combines compatible procedures into a fresh candidate and retires the originals without adding their success counts together.
- **`forget_skill`** removes a procedure from recall using a tombstone and retained history. This prevents accidental reimport; it is not secure erasure, and existing vector caches, artifacts and backups remain.
- **`recall_memory`** returns relevant skills, previous experiments, observed failures and recorded project constraints. It balances relevance, confidence, age, domains and type diversity instead of filling context with similar skills. **`read_memory_artifact`** reads the associated bounded experiment record. Historical observations remain advisory and cannot override instructions, permissions or budgets.

Recall uses local lexical matching by default. Set **`codeflare.memoryEmbeddingModel`** to an explicit embedding model to add semantic vector search through the active **local or OpenAI-compatible endpoint and its provider token**. This sends the query and selected memory snippets to that provider; the setting is blank by default, and Anthropic's native endpoint is unsupported. Embedding failures produce a warning and fall back to lexical matching. Vectors are cached by endpoint/model and content version, and project vectors remain in project storage. Semantic recall considers at most 256 candidate memories per request.

The embedded `sql.js` SQLite/WASM runtime ships with the extension, while database files and larger content-addressed artifacts remain in extension storage. This is a bounded prototype: SQLite writes use file locking and atomic database export, and vector search scans cached vectors with cosine similarity; it is not an approximate-nearest-neighbor service. Restart and cross-workspace tests establish persistence and isolation. Demonstrating faster or better work on project B after learning in project A still requires a controlled coding benchmark.

On first use, legacy `knowledge.json` stores are migrated into SQLite and their source files are retained as backups. Existing `.codeflare/memory.md` and `.codeflare/knowledge.json` are imported into private **project** storage without promoting content globally. Unsupported newer database schemas are left intact and reported as unavailable. Run logs, checkpoints and verification configuration can still live in `.codeflare/` as project task artifacts.

To improve the extension itself, open the **CodeFlare source repository** and run **CodeFlare: Improve CodeFlare**. Describe one bounded improvement. After the implementation and independent tests complete, the updater validates an isolated candidate snapshot against committed baseline tests, type checking, a build and an isolated VS Code activation/command-registration smoke check.

`codeflare.selfImprovement` defaults to **`suggest`**: it prepares the candidate for review. **`automatic`** opts into installation and reload after validation; **`off`** disables the Improve command. You can also use **CodeFlare: Prepare and Validate Self-update**, followed by **CodeFlare: Activate Validated Self-update**.

Before using this workflow:

1. Manually install a working release with self-update support, such as **1.42.0**. Its installed smoke and recovery runners are needed to validate later candidates.
2. Keep that release's VSIX and set its absolute path in `codeflare.selfUpdateKnownGoodVsix`. Before activation, its extension bundle must match the currently installed one.
3. Ensure `codeflare.selfUpdateCli` (default `code`) targets this VS Code installation. Preparation also needs Git, Node.js/npm, the source lockfile and the locked development toolchain.

Activation saves the idle mission, installs the checked artifact and reloads. An independent recovery helper attempts to reinstall the retained package if startup health is not acknowledged. After a crash or rollback, a manual window reload may still be needed. The smoke check establishes startup and command registration; it does not verify every UI flow or prove better coding performance. Keep the VSIX for each successfully activated version before preparing another update.

## The agent loop

Every turn drives toward *verified* completion, not just "the model stopped talking":

```
edit → editor diagnostics → stack-aware build/test → analyze output → fix → re-check → diff review → done
```

- **Diagnostics loop** — after edits, new editor errors (including regressions in files it didn't touch) are fed back for a bounded number of fix rounds.
- **Verify gate** — runs the *project's own* build/typecheck/test command for each changed module (auto-detected, or set `codeflare.verifyCommand`) and feeds failures back. A module that already passed and hasn't changed isn't re-run.
- **Requirement review** — before finishing, the model checks its own diff against your request *one requirement at a time*, mapping each to the **evidence of what actually ran this turn** (requirement → tool result → met / unmet / **unverified**). A requirement to *verify the behavior* can't be marked met by diagnostics or a build alone — if nothing actually exercised it (a run, a test, a screenshot), it's **unverified** and blocks "done". The evidence is order-aware, so an ordering requirement ("reproduce the bug *before* fixing") isn't satisfied by a run that only happened after the edit; and a side effect the diff doesn't show — a dependency install touching `package.json`/lockfiles — is counted against "don't change unrelated code". "Self-review passed" only appears when every requirement is met; unmet ones are fixed within bounds, and if the fix rounds run out the still-unmet requirements are surfaced to you rather than silently declared done.
- **Ambiguity gate** — when a request hinges on a concept that doesn't exist anywhere in the codebase (e.g. "open a *project*" in an app with no project concept), the agent asks one clarifying question before planning instead of guessing. CodeFlare surfaces which request terms it couldn't find in the code as evidence.
- **Calibrated reviews** — ask for *suggestions* or a *review* (not changes) and findings come with **confidence, impact, evidence and compatibility risk**, prioritized by what actually matters here — not a padded list. It won't hand you confidently-wrong security tips (base64'd API "keys", an `allow-same-origin` sandbox, or a `default-src 'self'` CSP that would break an app calling other hosts), and stays advisory: no edits unless you ask.

## What it can do

**Read & navigate** — `read_file` (with line ranges), `list_files`, `search_text`, `find_files`, `find_related` (ranked retrieval over a compact repo map), `get_diagnostics`.

**Edit reliably** — `edit_file` (exact search/replace with whitespace-tolerant fallback), `apply_patch` (unified diff; **atomic** — a multi-file patch applies fully or not at all), `create_file`, `move_file`, `delete_file` (soft-delete to `.codeflare-trash`, recoverable), `rename_symbol` (via the language server).

**Run & verify** — `run_command` (tests, builds, git, servers) with output fed back; stack-aware verification sourced from the project's own config.

**Investigate at runtime** — temporary one-line **probes** you can read back, or the **debugger** tools (breakpoints, start/continue/step, inspect call stack & variables, evaluate) built on the project's own `launch.json` *(beta, opt-in)*.

**Orchestrate** — `run_subagent` / `run_subagents` for independent sub-tasks, each returning a structured result, with a configurable mission-wide concurrency limit of 1–32.

**See its output** — `verify_visual` sends a produced screenshot/plot/render back to a vision-capable model to check it matches the intent; generated PNGs are pixel-checked for blank/broken output. `screenshot_url` captures an external web page as a PNG via a real headless browser (normal User-Agent, so bot-protected sites are less likely to serve a "denied" page).

**Reach the web** — `web_fetch` (page as text), `web_search`, `web_extract` (harvest one page's links, images, emails and title — `render:true` runs it in a real browser for JS/news/SPA sites), and `crawl_site` (follow links across a site with loop detection, on-domain by default, capped at `max_pages` — default 8).

**Use any web API from a key** — hand the chat an API key ("here is my PixelLab key …") or add it via **CodeFlare: Add API Key for an External Service**, and the agent works the service end-to-end on its own: `api_store_key` keeps the key encrypted in VS Code SecretStorage (the model only ever uses the service *name*), `api_discover` finds and caches the OpenAPI spec (conventional locations, `api.<domain>`, links in `llms.txt`/docs) and returns a compact endpoint index, `api_describe` gives the exact fields/enums of one operation, and `api_request` calls it with the key injected — only to that service's own host. Binary responses and base64 images in JSON land as workspace files (previewed and pixel-checked like any generated image), `{"$file":"sprite.png"}` in a body sends a workspace image, and asynchronous jobs are awaited in one call with `poll`. Keys are redacted from everything the model sees.

**Generate 3D models** — point `codeflare.blenderPath` at your Blender install and the agent builds meshes headlessly: it writes a `bpy` script (reviewable and checkpointed like any file), runs `blender --background --python`, and exports STL via the current `wm.stl_export` operator. Detected as a stack wherever a `.blend` or a `bpy`-importing script lives, so the right invocation — correctly quoted for `C:\Program Files\…` — is always at hand. Every STL produced is then **geometrically checked**: triangle count, bounding box, degenerate faces and watertightness. An empty export (the classic "exported before the geometry existed") or a truncated file feeds straight back for a fix round, and the measured geometry is handed to the model so it reports numbers instead of claiming the shape is right. Stronger than a screenshot — watertightness is a proven property, not an impression of a picture.

**Remember and relearn** — project facts, experiments and observed failures stay in private workspace storage. General skills can be promoted to global memory, revised, merged or retired; evidence and age determine their eligibility for future recall. `recall_memory` retrieves a relevant mix of these records.

## Reliability & safety

- **Turn checkpoints / undo** — every file a turn mutates is captured beforehand, so a whole turn can be reverted.
- **Workspace sandbox** — file *writes* stay strictly inside the workspace; reads may also reach the OS temp dir and any folders you add to `codeflare.artifactRoots` (for program output that lands in appdata, etc.).
- **Command confirmation** — shell commands prompt for approval, except a built-in safe list plus your `codeflare.trustedCommands`. Deletes are soft (moved to trash), not destroyed.
- **Stack confidence** — in a monorepo, a stray `package.json` / `index.html` / loose `.ps1` is flagged *low confidence* so the model treats it as a stray file, not a real module.
- **Guardrails the agent cannot loosen** — the files that constrain the agent (policy and its gate, evidence and acceptance, git isolation, write ownership, the self-update and recovery path) are locked during a self-improvement task: unwritable through the file tools, unwritable and un-committable through `run_command`, and a self-update candidate whose guardrails differ from the last human-activated version is refused unless you approve the exact files in a modal. A prompt asks the model to preserve them; these three layers make sure of it.
- **Independent judge** — point `codeflare.judgeProvider/Endpoint/Model` at a different model and requirement review, *Prove It*, *Break My Solution* and memory reflection run there instead of on the model that did the work. Same weights cannot independently review themselves, so a judge that resolves to the working model is treated as absent, and metrics only record `judgeModel` when the judge really was independent.
- **Calibration that bites** — `metrics.jsonl` records, per turn, what the model *claimed* and what a check *demonstrated*. That gap now feeds back: a model whose recent record in this workspace is "done without a demonstrating check" is told its own numbers in the prompt, and a behavioural check becomes mandatory for every turn — not only when you asked for one. A reliable record is acknowledged; a thin sample changes nothing.
- **Mission budget and stop rule** — a turn budget bounds one turn; `codeflare.missionBudget` bounds the whole autonomous mission (turns, tool calls, tokens, wall time) and pauses a mission that makes no measurable progress for several turns, with the reason shown. Resuming an exhausted mission is refused before anything runs.
- **Skills proven causally** — "the mission passed while the skill was recalled" is correlation. In a fraction of autonomous missions (`codeflare.skillHoldoutRate`) an eligible skill is withheld and the outcome recorded as a *control trial*; once enough exist, a skill's **lift** over its own absence is computed and a skill with no lift drops back to candidate however often it "worked".
- **Night Shift** — reflection turns recurring failures, contradictions between skills and unaccepted missions into a **backlog** of evidence-cited goals (`CodeFlare: Show Backlog`). `CodeFlare: Night Shift` works them one autonomous mission at a time under the mission budget and the guardrail lock; each goal prompt tells the mission to stop and report when the problem does not reproduce. The system chooses what to do; a human still presses the button, and only in a non-interactive profile so nothing waits on a prompt nobody will answer.

## Configuration

CodeFlare has extensive settings under the **CodeFlare** section (Settings → search "codeflare"). Highlights:

| Setting | Default | What it does |
|---|---|---|
| `codeflare.provider` | `local` | `local` / `openai` / `anthropic`. |
| `codeflare.endpoint` / `.model` | (blank) | Override the provider default / auto-discovery. |
| `codeflare.agentMode` | `true` | Let the model explore and use tools. |
| `codeflare.agentMaxSteps` | `25` | Max tool-calling steps per message. |
| `codeflare.autonomousMode` | `false` | Plan, build and independently test a mission within existing permissions. |
| `codeflare.autoTest` | `false` | Add a separate test-authoring and execution stage after implementation. |
| `codeflare.maxParallelAgents` | `32` | Shared mission pool limit, from 1 to 32; excess tasks queue. |
| `codeflare.memoryEmbeddingModel` | (blank) | Opt in to semantic recall using this embedding model on the active local/OpenAI endpoint; sends query and memory snippets there. Blank uses local lexical recall. |
| `codeflare.selfImprovement` | `suggest` | Improve command mode: `off`, prepare for review, or opt-in `automatic` activation. |
| `codeflare.selfUpdateKnownGoodVsix` | (blank) | Retained VSIX matching the installed bundle; required before activation. |
| `codeflare.selfUpdateCli` | `code` | CLI for the same VS Code installation as the extension. |
| `codeflare.confirmCommands` | `true` | Prompt before shell commands (except trusted). |
| `codeflare.confirmEdits` | `false` | Diff-and-confirm before each write. |
| `codeflare.verifyGate` / `.verifyCommand` | `true` / auto | Verify after edits; command auto-detected per stack. |
| `codeflare.diagnosticsLoop` / `.diffReview` | `true` | Auto-fix editor errors; per-requirement self-review before done. |
| `codeflare.clarifyAmbiguity` | `true` | Ask one question when a request hinges on a concept absent from the codebase. |
| `codeflare.repoMap` | `true` | Inject a compact project map + `find_related`. |
| `codeflare.visualVerify` | `true` | Offer `verify_visual` (needs a vision-capable model). |
| `codeflare.agentDebug` | `false` | Enable the debugger tools (beta). |
| `codeflare.metrics` | `true` | Record per-turn metrics to `.codeflare/metrics.jsonl`. |
| `codeflare.mcpServers` | `{}` | Connect MCP servers (beta); their tools appear as `mcp__<server>__<tool>`. |
| `codeflare.blenderPath` | (blank) | Where Blender is installed, for headless 3D/STL generation. Install folder, its parent, or the executable. |
| `codeflare.meshQC` | `true` | Geometrically check generated STLs (empty/truncated/collapsed) and feed problems back. |
| `codeflare.judgeProvider` / `.judgeEndpoint` / `.judgeModel` | (blank) | An independent model that reviews the worker's output (requirement review, Prove It, Break My Solution, reflection). Blank = the worker reviews itself. |
| `codeflare.memoryReflection` | `manual` | When the reflection pass runs (`manual` via **CodeFlare: Reflect on Experience** or the Memory tab; `after-mission` also after a completed mission once ≥5 new experiments were recorded). Reflection proposes *candidate* skills and constraints — it never validates. |
| `codeflare.missionBudget` | `{}` | Ceilings for an **autonomous mission as a whole**: `maxTurns` (12), `maxToolCalls` (600), `maxTokens` (1.5M), `maxWallMs` (90 min), `maxStalledTurns` (3 turns with no file change and no passing evidence). A mission that hits one is paused with the reason. |
| `codeflare.skillHoldoutRate` | `0.1` | Causal skill validation: in this fraction of autonomous missions an eligible skill is withheld and the outcome recorded as a **control trial**. A skill that does no better without it than with it cannot stay validated. `0` disables. |
| `codeflare.nightShiftMaxItems` | `1` | How many evidence-derived backlog goals one **CodeFlare: Night Shift** run works, each as its own autonomous mission. Needs a non-interactive `autonomyProfile`. |
| `codeflare.pentestMode` | `false` | Tells the agent it operates under an authorized, in-scope security engagement. Enable only for assets you own or are contracted to assess. |

## Commands & shortcuts

- **CodeFlare: Open Chat** — `Ctrl/Cmd+Shift+Q`
- **CodeFlare: Send Selection to Chat** — `Ctrl/Cmd+Shift+L`
- Right-click a selection for **Explain / Refactor / Fix Bug / Add Tests / Document Code**
- **Check VLLM Health**, **Check Environment**, **Stop Agent Servers**, **Metrics Report (compare models)**, **Clear Chat**
- **Add API Key for an External Service** / **Remove External Service API Key** — store or drop a named key (e.g. `pixellab`) without pasting it into the chat
- **CodeFlare: Resume Mission** / **CodeFlare: Save Mission and Reload**
- **CodeFlare: Memory Status** — check persistent memory readiness and record counts
- **CodeFlare: Improve CodeFlare** / **CodeFlare: Prepare and Validate Self-update** / **CodeFlare: Activate Validated Self-update**

## The `.codeflare/` directory

Local, git-ignorable, never shipped in the extension:

- `memory.md` / `knowledge.json` — legacy memory files, imported once into private VS Code project storage and retained as backups. New memory is stored outside the repository.
- `metrics.jsonl` — one line per turn (effort, reliability, tokens, wall-clock, and *what verification actually demonstrated* vs. what the model claimed). Compare models with **CodeFlare: Metrics Report**.
- `probes.jsonl` — runtime probe output.
- `.codeflare-trash/` — soft-deleted files.

## Build and package from source

Run `npm ci`, `npm run lint`, `npm test` and `npm run package` to check and package the extension. Packaging builds the bundle but **does not install or reload it**. Use `npm run deploy` explicitly to install the versioned VSIX, then reload VS Code. Older VSIX files are retained for rollback.

## Requirements

- VS Code `^1.85`.
- A reachable backend: an OpenAI-compatible server for `local`, or an API token for OpenAI/Anthropic.
- For the verify gate / debugger: the project's own toolchain (npm, tsc, pytest, go, cargo, dotnet, gradle, a Godot binary, …). CodeFlare never invents a build strategy or installs tools — it uses what the project already defines.
- For 3D/STL generation: Blender 4.2 or newer (tested against 5.1), located via `codeflare.blenderPath`.

## License

[MIT](LICENSE) — free to use, modify and distribute, including commercially, as long as the copyright notice and licence text travel with it.

Built by [Redflare](https://www.redflare.nl).
