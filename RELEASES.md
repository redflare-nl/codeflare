# Releases

Download the `.vsix` for a release from the [Releases page](../../releases), then
install it with **Extensions → … → Install from VSIX…**, or from a terminal:

```
code --install-extension codeflare-<version>.vsix
```

Reload the window afterwards (**Developer: Reload Window**) to activate it.

> **Updating is manual.** A `.vsix` installed from a file is not tracked by any
> marketplace, so VS Code will never offer to update it. To move to a newer
> version, download the new `.vsix` and install it the same way — `--force`
> replaces the installed copy. CodeFlare is not published to the VS Code
> Marketplace or Open VSX.

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
