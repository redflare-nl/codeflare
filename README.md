# CodeFlare

An agentic AI coding assistant for VS Code that runs a full **edit → diagnose → build/test → review → fix** loop against a **local** model (OpenAI-compatible server), **OpenAI**, or **Anthropic** — your choice, switchable per project.

CodeFlare's design principle: **the model is the brain; CodeFlare provides the eyes, hands, and feedback.** It offers capabilities (read/edit files, run commands, verify, debug) deterministically; the model decides which to use and in what order.

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

**Orchestrate** — `run_subagent` / `run_subagents` for independent sub-tasks (up to 4 in parallel), each returning a structured result.

**See its output** — `verify_visual` sends a produced screenshot/plot/render back to a vision-capable model to check it matches the intent; generated PNGs are pixel-checked for blank/broken output. `screenshot_url` captures an external web page as a PNG via a real headless browser (normal User-Agent, so bot-protected sites are less likely to serve a "denied" page).

**Reach the web** — `web_fetch` (page as text), `web_search`, `web_extract` (harvest one page's links, images, emails and title — `render:true` runs it in a real browser for JS/news/SPA sites), and `crawl_site` (follow links across a site with loop detection, on-domain by default, capped at `max_pages` — default 8).

**Remember** — durable project facts in `.codeflare/memory.md` via `remember` / `forget` (kept for real project knowledge — engine, how tests run, architecture — not re-derivable code trivia).

## Reliability & safety

- **Turn checkpoints / undo** — every file a turn mutates is captured beforehand, so a whole turn can be reverted.
- **Workspace sandbox** — file *writes* stay strictly inside the workspace; reads may also reach the OS temp dir and any folders you add to `codeflare.artifactRoots` (for program output that lands in appdata, etc.).
- **Command confirmation** — shell commands prompt for approval, except a built-in safe list plus your `codeflare.trustedCommands`. Deletes are soft (moved to trash), not destroyed.
- **Stack confidence** — in a monorepo, a stray `package.json` / `index.html` / loose `.ps1` is flagged *low confidence* so the model treats it as a stray file, not a real module.

## Configuration

CodeFlare has extensive settings under the **CodeFlare** section (Settings → search "codeflare"). Highlights:

| Setting | Default | What it does |
|---|---|---|
| `codeflare.provider` | `local` | `local` / `openai` / `anthropic`. |
| `codeflare.endpoint` / `.model` | (blank) | Override the provider default / auto-discovery. |
| `codeflare.agentMode` | `true` | Let the model explore and use tools. |
| `codeflare.agentMaxSteps` | `25` | Max tool-calling steps per message. |
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
| `codeflare.pentestMode` | `true` | Tells the agent it operates under an authorized, in-scope security engagement. Turn off for ordinary coding. |

## Commands & shortcuts

- **CodeFlare: Open Chat** — `Ctrl/Cmd+Shift+Q`
- **CodeFlare: Send Selection to Chat** — `Ctrl/Cmd+Shift+L`
- Right-click a selection for **Explain / Refactor / Fix Bug / Add Tests / Document Code**
- **Check VLLM Health**, **Check Environment**, **Stop Agent Servers**, **Metrics Report (compare models)**, **Clear Chat**

## The `.codeflare/` directory

Local, git-ignorable, never shipped in the extension:

- `memory.md` — durable project facts the agent proved.
- `metrics.jsonl` — one line per turn (effort, reliability, tokens, wall-clock, and *what verification actually demonstrated* vs. what the model claimed). Compare models with **CodeFlare: Metrics Report**.
- `probes.jsonl` — runtime probe output.
- `.codeflare-trash/` — soft-deleted files.

## Requirements

- VS Code `^1.85`.
- A reachable backend: an OpenAI-compatible server for `local`, or an API token for OpenAI/Anthropic.
- For the verify gate / debugger: the project's own toolchain (npm, tsc, pytest, go, cargo, dotnet, gradle, a Godot binary, …). CodeFlare never invents a build strategy or installs tools — it uses what the project already defines.
