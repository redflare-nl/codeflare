# Releases

Download the `.vsix` for a release from the [Releases page](../../releases), then
install it with **Extensions → … → Install from VSIX…**, or from a terminal:

```
code --install-extension codeflare-<version>.vsix
```

Reload the window afterwards (**Developer: Reload Window**) to activate it.

> **No marketplace updates.** Install downloaded releases manually; `--force`
> replaces the installed copy. Starting with 1.41.0, an optional source-based
> self-update workflow can validate and activate candidates after an initial
> manual installation. CodeFlare is not published to the VS Code Marketplace
> or Open VSX.

---

## v1.42.1

**Hotfix — install this instead of v1.42.0.** In v1.42.0 every model call failed with *"Maximum call stack size exceeded"*: the client's settings accessor called itself after a blanket rename during the independent-judge work. No test exercised a client method, so it shipped. Fixed, and a regression test now constructs the client and reads its configuration. Nothing else changed.

---

## v1.42.0

Persistent memory now tracks evidence, uncertainty and revision history across projects.

- **SQLite outside the runtime.** Project and global knowledge use separate `memory.sqlite` files in VS Code storage, with content-addressed artifact directories. Existing `knowledge.json` files migrate with backups retained. The embedded SQLite/WASM runtime ships with the extension; self-updates leave stored memory in place.
- **Confidence and relearning.** Skill confidence combines current-version successful/failed uses with a 90-day decay; it is an evidence heuristic, not a probability. Inconclusive trials are neutral. Global automatic reuse needs current successful evidence from two missions in two workspaces and confidence of at least 0.70. Failures trigger a 24-hour cooldown. Correction and merging create fresh candidates; promotion does not copy project proof, and forgetting retires a skill with a tombstone rather than securely erasing history.
- **Typed recall.** `recall_memory` balances relevant skills, experiments, observed failures and project constraints using confidence, freshness, domains and type diversity. Project episodes and vectors remain scoped to the workspace. **CodeFlare: Memory Status** reports storage readiness and counts.
- **Optional semantic retrieval.** Set `codeflare.memoryEmbeddingModel` to use real embeddings from the active local/OpenAI-compatible provider. Queries and selected memory snippets are sent there. Blank uses local lexical matching; provider errors fall back with a warning. The implementation uses bounded cosine scans and cached vectors, with SQLite file locking and atomic exports.

### The self-improvement layer

What turns a thoroughly verifying tool into a system that can learn without supervision — and what keeps that safe.

- **Guardrails the agent cannot loosen.** The files that constrain the agent (policy and its gate, evidence and acceptance, git isolation, write ownership, self-update and the recovery scripts) are locked during a self-improvement task in three layers: unwritable through the file tools, unwritable and un-committable through `run_command` (a shell write followed by `git commit` would otherwise make the edit look like the baseline), and a self-update candidate whose guardrails differ from the last human-activated version is refused unless the exact files are approved in a modal. The command-trust list in `tools.ts`/`config.ts` is deliberately not locked — it is the normal improvement surface — and that gap is documented, not hidden.
- **Independent judge.** `codeflare.judgeProvider/Endpoint/Model` route requirement review, *Prove It*, *Break My Solution* and reflection to a different model than the one that did the work. A judge that resolves to the working model is treated as absent, and metrics record `judgeModel` only when the judge was really independent.
- **Reflection.** **CodeFlare: Reflect on Experience** (or the Memory tab, or `codeflare.memoryReflection: after-mission`) reads recorded experiments and proposes *candidate* skills, project constraints, contradictions between stored skills and recurring failure patterns. Every constraint must cite at least two known episodes; proposals that would weaken verification are rejected; nothing is validated by reflection itself.
- **Calibration that feeds back.** The per-turn record of what the model *claimed* versus what a check *demonstrated* now changes behaviour: a model with a measured habit of "done" without a demonstrating check is told its own numbers and gets a mandatory behavioural check on every turn. A thin sample changes nothing; a reliable record is acknowledged.
- **Mission budget and stop rule.** `codeflare.missionBudget` bounds an autonomous mission as a whole (turns, tool calls, tokens, wall time) and pauses one that makes no measurable progress for several turns, with the reason shown. Resuming an exhausted mission is refused before anything runs.
- **Causal skill validation.** In a fraction of autonomous missions (`codeflare.skillHoldoutRate`, default 0.1) an eligible skill is deliberately withheld and the outcome recorded as a *control trial*. Once enough controls exist, a skill's lift over its own absence is computed; a skill with no lift drops back to candidate however often a mission passed with it. Interactive turns never withhold.
- **Night Shift.** Reflection also derives a backlog of evidence-cited goals — recurring failures, contradictions, missions that ended unaccepted (**CodeFlare: Show Backlog**). **CodeFlare: Night Shift** works them one autonomous mission at a time under the mission budget and the guardrail lock; each goal prompt requires acceptance criteria first and tells the mission to stop and report when the problem does not reproduce. A human still presses the button, and only in a non-interactive `autonomyProfile`.
- **Memory tab.** The chat settings panel gained a Memory tab: current counts, *Reflect on recorded experiments*, and *Clear this project / agent memory / everything* — each behind a confirmation, each reporting what was actually removed. Clearing archives a legacy `knowledge.json` instead of letting it re-import what was just deleted.
- **Fix:** global storage under a `vscode-userdata` URI (a plain local install) was treated as "not file-backed", which disabled memory entirely. Any storage URI that resolves to a local absolute path is now accepted; remote and virtual filesystems are still excluded.

Memory remains local to the VS Code profile/extension host, without automatic cloud synchronization. Tests of restart and cross-project recall verify persistence and isolation; improved coding speed or quality requires a separate controlled benchmark. See [README.md](README.md#project-knowledge-and-self-improvement) for eligibility rules, storage, migration and privacy details.

---

## v1.41.1

Memory now lives in VS Code's extension storage, with separate workspace and cross-project scopes.

- **Three memory layers.** Conversations and active missions stay in `workspaceState`. Project facts, landscapes and project skills use `storageUri`; reusable agent skills use `globalStorageUri`. New memory files are stored outside the repository.
- **Explicit skill scope.** `save_skill` and `try_skill` accept `project` (default) or `global`, and `list_skills` shows the scope. Relevant global skills enter future task context only after validation with passing execution evidence. Saving a skill alone does not validate it.
- **Project-only migration.** Existing `.codeflare/memory.md` and `.codeflare/knowledge.json` are imported once into private project storage. Original files remain as backups; no legacy content is automatically promoted to global memory.

Global memory is shared across workspaces using the same extension storage; it is not automatic cloud sync across machines, profiles or remote hosts. Project run logs, checkpoints and verification settings remain task artifacts. See [README.md](README.md#project-knowledge-and-self-improvement) for the storage layout.

---

## v1.41.0

Persistent missions, independent test authoring and controlled self-updates.

- **Live progress footer.** Exploration, design, build/repair, verification and delivery stay visible above the input. Backward transitions include their reason; expandable history shows agent tasks and results. Stop remains available during the separate test stage.
- **Remembered task controls.** **Autonoom uitvoeren** and **Tests schrijven en uitvoeren** both default to off. Autonomous mode includes testing and skips plan approval while preserving existing command permissions, path rules and budgets. A separate test agent works from the original request; the coordinator actually executes the tests and sends failures back for bounded repairs. Missing or inconclusive test evidence does not count as a pass.
- **Parallel work.** `codeflare.maxParallelAgents` sets a shared pool of **1–32** concurrent subagents per mission, default **32**. Additional tasks queue. Ownership checks and serialized mutations coordinate the shared workspace; the coordinator handles commands and integration. New limits apply to the next mission.
- **Resume after reload.** Saved mission state includes phases, transitions, changed files and agent results. Interrupted work is reconciled through **CodeFlare: Resume Mission** or **Hervatten**, rather than automatically replaying tool calls. **CodeFlare: Save Mission and Reload** saves an idle mission before reloading.
- **Landscapes and reusable skills.** The agent can record sources, acceptance criteria, decisions and unknowns, and save candidate procedures in `.codeflare/knowledge.json`. Skills need a successful trial with current passing test/runtime evidence before automatic reuse. This records observed success, not benchmark-proven improvement.
- **Self-improvement workflow.** **CodeFlare: Improve CodeFlare** works in the extension's source repository. The default `codeflare.selfImprovement: "suggest"` prepares a candidate; `"automatic"` opts into activation after validation. **Prepare and Validate Self-update** checks an isolated snapshot against committed tests, type checking, build and a VS Code activation/command-registration smoke test. **Activate Validated Self-update** installs the tested artifact and reloads.

Self-updates require an initial manual installation of a working release with the smoke and recovery runners. Before activation, set `codeflare.selfUpdateKnownGoodVsix` to a retained VSIX matching the installed bundle, and ensure `codeflare.selfUpdateCli` targets the same VS Code installation. An external helper attempts automatic reinstallation of that package if startup health fails; a manual reload may still be needed after a crash or rollback. The smoke test does not cover every UI flow or establish improved coding performance.

**Packaging no longer deploys.** `npm run package` builds the VSIX; installation is explicit with `npm run deploy`. Older packages are preserved.

**Requires** VS Code 1.85+. Source-based self-updates also require Git, Node.js/npm and the locked development toolchain. See [README.md](README.md#project-knowledge-and-self-improvement) for setup.

---

## v1.40.0

Three features in one release.

### Blender: headless 3D / STL generation

Point `codeflare.blenderPath` at a Blender install and the agent generates meshes
on its own: it writes a `bpy` script through the normal write tools (so the script
is reviewable and checkpointed like any file), runs
`blender --background --python`, and exports STL.

- The path setting accepts whichever form you have to hand — the executable, the
  install folder, or the vendor folder above it (the newest version wins). No
  need to retype a version number after an upgrade.
- Blender is registered as a discovered executable, so running it needs no
  confirmation prompt and stack detection builds correctly quoted commands for
  paths like `C:\Program Files\…`.
- Detected as a stack wherever a `.blend` file or a Python script that genuinely
  imports `bpy` lives.
- The agent is told to use the current `bpy.ops.wm.stl_export` operator rather
  than the deprecated `export_mesh.stl` add-on, to clear the scene first (a fresh
  Blender's default cube otherwise ends up in the export), and to set dimensions
  explicitly, since Blender's unit is the metre and a "20 mm" part is `0.02`.

### Mesh QC: generated meshes are checked, not assumed

Every STL the agent produces is parsed and measured — triangle count, bounding
box, degenerate faces, welded vertex count and watertightness — and the numbers
go back to the model. Empty, truncated, malformed or collapsed geometry triggers a
bounded fix round, the same way failing diagnostics do.

This catches the failure mode that otherwise passes silently: exporting before the
geometry exists writes a valid 84-byte STL containing nothing at all, and Blender
does not complain.

An open mesh — a plane, a surface patch — is reported but not treated as a fault.
Watertightness is a proven property of the geometry rather than an impression of a
picture, which makes it stronger evidence than a screenshot.

Toggle with `codeflare.meshQC` (on by default).

### External web APIs from a key

Hand the chat an API key, or add one via **CodeFlare: Add API Key for an External
Service**, and the agent uses that service end to end: it finds and caches the
OpenAPI spec, reads the exact fields of the one operation it needs, and makes the
call with the key injected — only ever to that service's own host. Keys live in
VS Code SecretStorage; the model works with the service *name* and never sees the
key, which is also redacted from everything it reads. Downloaded files and
base64 images in responses land in the workspace through the normal write gate,
and asynchronous jobs are awaited in a single call.

### Adaptive reasoning

Requests are classified (performance, debugging, puzzle, open reasoning) and the
matching reasoning discipline is added to that turn only — reproduce-first for a
bug, measure-a-baseline for an optimisation. Simple requests stay light instead of
paying for advice they cannot use. Penetration-testing mode is now **off** by
default, which keeps its framing out of ordinary coding turns.

### Also in this release

- MIT licensed.
- Machine-specific Claude Code settings are no longer tracked.
- Test tooling is kept out of the packaged extension.

**Requires** VS Code 1.85+. For 3D generation: Blender 4.2 or newer (tested
against 5.1).

---

## v1.37.0 — earlier work (no download)

Kept here for context; there is no published `.vsix` for this version, and its
features are all included in v1.40.0 above.

The evidence-driven engineering runtime — the release that made CodeFlare verify
its own work rather than report that it finished.

- **Typed evidence and fail-closed acceptance.** What actually ran during a turn
  is recorded, and a change can never be marked accepted when a gate failed or
  when nothing was verified at all.
- **Change budgets and path policy.** Opt-in autonomous profiles cap how many
  files and lines a single turn may touch, block protected paths, and refuse
  untrusted commands outright instead of prompting.
- **The Lab.** Scratch scripts, reproductions, benchmarks and old-vs-new
  equivalence checks run in an isolated directory rather than in the project
  tree. An optimisation claim has to come with measurements: profile, benchmark
  the baseline, change, benchmark again, and check behaviour is identical.
- **Prove It / Break My Solution.** Two commands that re-examine the last change
  in a write-locked turn — one to verify it independently, one to attack it.
- **Profiling and scaling.** Hot-path reports and observed time-vs-input-size
  growth, reported as measured on the tested range and never as proven Big-O.
- **Git isolation.** Autonomous turns run on their own branch; accepted work is
  fast-forward merged, rejected work is committed on the branch with the
  known-good tree restored.
- **Context bounding.** Prompts that would exceed a local server's context window
  are trimmed mid-turn and retried, fixing recurring `exceed_context_size_error`
  failures against llama.cpp.
- Checkpoints survive a window reload, so a turn can still be reverted afterwards.
