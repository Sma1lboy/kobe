# kobe (codename, rename later)

## Project at a glance

kobe is a local-first terminal UI for running many AI coding sessions at once — Conductor's multi-task shape (task sidebar, workspace chat/files tabs, file tree, embedded terminal, status bar) made terminal-native with git worktrees and local engine processes.

The product unit is:

```text
Task = git worktree + engine session + branch
```

The TUI is the product; engine adapters are execution backends (Claude Code is the default, Codex lives behind the same engine-owned contract). This file is a lean operator manual — **boundaries and orientation only**. Mechanics live in `docs/`; the current version + shipped behavior live in [`packages/kobe/package.json`](./packages/kobe/package.json) and [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md). Don't duplicate those here.

**Read in order before doing anything:**
1. [`HANDOFF.md`](./HANDOFF.md) — freshest handoff, current risks, open follow-ups. Local + gitignored; absent on a fresh clone is fine, just skip it.
2. [`docs/DESIGN.md`](./docs/DESIGN.md) — design philosophy, decisions, tech-stack lock-in.
3. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — source-tree map, ownership boundaries, and the `refs/` reference projects (§7).
4. [`docs/PLAN.md`](./docs/PLAN.md) — phase/wave plan + gate history (**phase status lives here, not in this file**).
5. [`docs/HARNESS.md`](./docs/HARNESS.md) — agent self-test contract. **Load-bearing.**
6. [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md) — pane-scope rules; read before adding/moving any chord.
7. [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md) — shipped behavior + release-note style.

The docs are the source of truth. **If docs and implementation disagree, surface the mismatch before widening scope.**

## Orientation

- **Monorepo (Bun workspaces), source under `packages/`:** `kobe/` (the TUI/CLI, published as `@sma1lboy/kobe`), `kobe-daemon/` (daemon server + protocol + socket client + daemon-hosted web transport), `kobe-web/` (the browser dashboard SPA + PTY sidecar), `branding/` (Remotion pipeline), `kobe-docs/` (public docs site, Fumadocs on Next.js, static export; content synced from `docs/`). Unqualified `src/…`/`test/…` paths in docs are relative to `packages/kobe/`. Full source-tree map: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
- **Run scripts** via `bun --filter @sma1lboy/kobe <script>` or `cd packages/kobe && bun <script>`. Two dev flavours: `dev` (real engines, **production** `~/.kobe`) and `dev:sandbox` (real engines, throwaway `packages/kobe/.dev-sandbox/home`) — use the sandbox so you never touch the real `~/.kobe/tasks.json`.
- **Tech stack is locked:** TypeScript + `@opentui/core` + `@opentui/react` + React 19 + Bun. Do not re-litigate. (The Solid TUI was removed 2026-07-07 — React is the only UI. Orchestrator/client reactivity is framework-free observable state; do not add UI-framework state primitives to the core.)
- **UI development is OpenTUI-first, with one visual ground truth.** Develop the real `packages/kobe/src/tui-react/**` surface through `dev:sandbox`. For every agent-driven visual iteration, screenshot, and UI acceptance check, the **only** ground-truth path is a fixed-viewport browser `/harness` → xterm.js → PTY sidecar → real OpenTUI. Do not use local Terminal screenshots, native `kobe-web` pages such as `/board`, render-test output, or alternate mocks as visual substitutes. The harness is infrastructure for observing OpenTUI; it does not make the web SPA the product surface. Work on native `kobe-web` pages only when explicitly requested or when a browser-only boundary must be tested.
- **Language:** respond in whatever language the user writes in. Don't assume their name — let them introduce themselves.
- **Daemon** is a long-lived background process, refcounted on attached GUIs (mechanics: [`docs/design/daemon.md`](./docs/design/daemon.md)). Boundaries: background consumers subscribe with `role: "pane"`; attached TUI clients and open browser SSE streams hold GUI lifetime; hosted engine PTYs belong to the separate PTY host and survive daemon restarts; read `<KOBE_HOME>/.kobe/daemon.log` first when debugging; **after editing daemon/orchestrator/engine code, `kobe daemon restart`** — Bun doesn't hot-reload.
- **Per-repo init:** a repo can ship `.kobe/init.sh` (runs before the engine, in the worktree) + `.kobe/init-prompt.md` (the engine's first message); repo files win over the per-user state.json override. Mechanics: [`src/state/repo-init.ts`](./packages/kobe/src/state/repo-init.ts).
- **Reference repos** (`refs/`, gitignored, **read-only**): clone before development — the clone list, what each is for, and when to consult it all live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §7.
- **User-facing docs set:** [`docs/CONCEPTS.md`](./docs/CONCEPTS.md), [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md), [`docs/ENGINES.md`](./docs/ENGINES.md), [`docs/SESSIONS.md`](./docs/SESSIONS.md), [`docs/CLI.md`](./docs/CLI.md), [`docs/API.md`](./docs/API.md) — behavior verified against source at writing time. When you change config keys, CLI verbs, `kobe api` verbs, engine support, or session/persistence behavior, update the matching page in the same PR. Published at [docs.kobe.sma1lboy.me](https://docs.kobe.sma1lboy.me) — a new user-facing page must be added to `SECTIONS` in [`packages/kobe-docs/scripts/sync-docs.mjs`](./packages/kobe-docs/scripts/sync-docs.mjs) or it never reaches the site.

## Work tracking — local only

No Linear. Backlog/open issues live in the daemon-owned issue store (web Issues page or `kobe api issue-*`, see [`docs/WORK-TRACKING.md`](./docs/WORK-TRACKING.md)); shipped behavior in [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md) (one Changeset per change, see [`docs/RELEASING.md`](./docs/RELEASING.md)); current risks/follow-ups in [`HANDOFF.md`](./HANDOFF.md); durable design decisions as Markdown in `docs/`. If a requirement needs external tracking, surface it first instead of filing it automatically.

## Hard rules (non-negotiable)

### How work lands on `main`
- **Default: PR.** Feature branch → commits → `gh pr create` → CI green (typecheck/test, behavior, file-size-cap, coverage-cap, Review CI) → `gh pr merge --squash --delete-branch`. The PR gates are where the hard rules below get enforced, so unattended/agent-driven work always takes this path.
- **Owner-supervised local iteration may skip the PR** (2026-07-10): work in a worktree, get green, then merge/cherry-pick into local `main`. Same quality gates (lint, typecheck, tests, changeset) still apply. Only when the owner is in the loop that turn.
- A direct push to `main` needs the owner to say so **in that turn** — never inferred, never carried over to the next task.
- `scripts/release.sh` pushes its own `chore: release — X.Y.Z` commit + tag (see [`docs/RELEASING.md`](./docs/RELEASING.md)).
- Never force-push; `git fetch` before pushing.

### Commits
- Commit at the end of each stream when green (per-stream commits are pre-authorized). Message: `<type>: <summary>` + a 2-3 sentence body.
- **NEVER** add `Co-Authored-By: Claude` / any AI/Anthropic attribution or "Generated with Claude Code" footers.
- **NEVER** use `--no-verify` / `--no-gpg-sign` or skip hooks. Fix the underlying issue.

### Releases
- **Changeset bump is `patch` by default.** Only an EXPLICIT instruction in that turn promotes it to `minor`/`major` — never infer `minor` from "it's a feature" (pre-1.0 ships features as patches). Confirm the bump and check for pending changesets that may override your choice before tagging.
- Release notes may thank human contributors/testers. No AI/Anthropic/Claude/Codex/tool attribution anywhere (commits, tags, notes).
- Run lint + typecheck locally before pushing; don't assume CI will catch it.

### Deletion
- **NEVER** delete files, branches, worktrees, or run `rm -rf` unless the user explicitly says "delete"/"remove" *in the same conversation turn* — including cleanup of stale worktrees or "fixing" layout by removing files. If a task seems to need deletion, surface and ask first.

### Scope
- Edit only files within the declared slice; surface cross-slice changes, don't make them silently.
- 3-strike rule: same root cause fails 3× → stop and surface. Max-depth: 3+ levels of sub-investigation → surface before going deeper.
- When fixing a feature, scope the requirement explicitly — if a fix applies to one subcommand/file, confirm whether it should extend to all similar cases before declaring it done.

### File size cap: ~500 lines (code-review gate)
- Every source file should stay at or under ~500 lines.
- If your change touches a file that is over 500 lines, the change is NOT done until that file is refactored/split back to ~500 or below — touch it → you own shrinking it. CI hard-gates this (`ci.yml` file-size-cap job on touched files) and the Review CI flags it as Blocking.
- New files must not be born over 500 lines.
- Exemptions: generated files, lockfiles, snapshots/test fixtures, and `refs/`. A deliberate exception needs a one-line justification in the PR/commit.

### Don't touch
- `refs/` — read-only study material, forever.
- Other agents' worktree slices — coordinate via the orchestrator.
- Workspace-level config (`/Users/jacksonc/i/CLAUDE.md`, global git config, etc.).

### Keybindings: every NEW or MOVED chord needs owner sign-off
Adding/moving a chord is a taste + muscle-memory call the owner makes, not the agent. Follow `docs/KEYBINDINGS.md` for the mechanical rules (pane scope, modifier tiers), but the PLACEMENT decision — direct chord vs prefix-sequence, which letter, what it may shadow — requires context the agent doesn't have: which keys are high-frequency for the owner (e.g. `ctrl+w`/`ctrl+t` stay direct), which collide with claude/codex in-terminal shortcuts, which are fine behind the prefix (e.g. `ctrl+f`). So: implement behind a PROPOSED chord if needed, but always surface new/changed bindings for discussion before (or immediately after) landing — never silently ship a chord as settled. Record each resolution + its reasoning in `docs/design/keybinding-decisions.md` so the next agent has the context (`docs/KEYBINDINGS.md` stays the user-facing vocabulary — update the chord tables there when the defaults change).

### Layout: flex-first, hardcode last
opentui boxes are Yoga flexbox. Default to flex flow (`flexGrow`/`flexShrink`/`flexBasis`/`flexDirection`) — panes share width by ratio, not pixels. Hardcoded `width={N}`/`height={N}` is acceptable only for a documented convention (e.g. the 12-cell sidebar rail), a terminal-grammar fixed glyph (a 2-cell `+`/`-` diff column), or a modal overlay. Never use `width={N}` to mean "this big proportionally" — that's `flexGrow={N}`. Avoid `height="100%"` (use `flexGrow={1}`).

### Engine-owned UI data
The engine adapter is the source of truth for agent/product identity, capabilities, history, and telemetry. Neutral layers (TUI, web, orchestrator) must NOT hard-code Claude/Codex strings or derive vendor metrics themselves:
- Name/label/placeholder copy comes from the engine registry (`AIEngine.identity`: `productName`/`shortName`/…) — e.g. `Ask ${engine.shortName}`, never a literal `"Ask Claude…"`.
- Model catalogs + context math come from `EngineCapabilities`, keyed by the task's vendor. History is an engine-owned `EngineHistory`; token/context/speed are engine-normalized — don't parse vendor transcript files or reconstruct speed in the UI.
- Subagent steps are engine-owned nested data (tagged by `parentId`, nested one level under the parent Agent row), not flattened transcript noise.
- A new pane needing engine-specific data → extend the engine contract first; don't thread ad-hoc vendor checks through TUI/orchestrator code.

### Diagrams in `docs/`: use Mermaid
Diagrams in `docs/` go in a ` ```mermaid ` fence (renders natively in GitHub + VS Code preview; PlantUML and friends don't). ASCII boxes only for tiny relationships (≤3 nodes, no states). Canonical example: [`docs/design/tasks.md`](./docs/design/tasks.md).

## Agent skills

Skill-driven flows (`to-issues`/`triage`/`to-prd`/`qa`) scribble in gitignored `.scratch/<feature>/` markdown — that's scratch, not the backlog. The daemon issue store stays the product backlog; GitHub Issues stay inbound-user-reports-only. Mechanics: [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md), [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md), [`docs/agents/domain.md`](./docs/agents/domain.md).
