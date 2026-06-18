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
3. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — source-tree map, ownership boundaries, and the `refs/` reference projects (§2).
4. [`docs/PLAN.md`](./docs/PLAN.md) — phase/wave plan + gate history (**phase status lives here, not in this file**).
5. [`docs/HARNESS.md`](./docs/HARNESS.md) — agent self-test contract. **Load-bearing.**
6. [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md) — pane-scope rules; read before adding/moving any chord.
7. [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md) — shipped behavior + release-note style.

The docs are the source of truth. **If docs and implementation disagree, surface the mismatch before widening scope.**

## Orientation

- **Monorepo (Bun workspaces), source under `packages/`:** `kobe/` (the TUI/CLI, published as `@sma1lboy/kobe`), `kobe-daemon/` (daemon server + protocol + socket client + daemon-hosted web transport), `kobe-web/` (the browser dashboard SPA + PTY sidecar), `branding/` (Remotion pipeline). Unqualified `src/…`/`test/…` paths in docs are relative to `packages/kobe/`. Full source-tree map: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
- **Run scripts** via `bun --filter @sma1lboy/kobe <script>` or `cd packages/kobe && bun <script>`. Two dev flavours: `dev` (real engines, **production** `~/.kobe`) and `dev:sandbox` (real engines, throwaway `packages/kobe/.dev-sandbox/home` + `KOBE_TMUX_SOCKET=kobe-sandbox`) — use the sandbox so you never touch the real `~/.kobe/tasks.json`.
- **Tech stack is locked:** TypeScript + `@opentui/core` + `@opentui/solid` + Solid.js + Bun. Do not re-litigate.
- **Language:** respond in whatever language the user writes in. Don't assume their name — let them introduce themselves.
- **Daemon** is a long-lived background process, refcounted on attached GUIs (mechanics: [`docs/design/daemon.md`](./docs/design/daemon.md)). Boundaries: a new daemon-subscribing surface uses `role: "pane"` (only the attached TUI is `"gui"`); daemon shutdown never touches tmux; read `<KOBE_HOME>/.kobe/daemon.log` first when debugging; **after editing daemon/orchestrator/engine code, `kobe daemon restart`** — Bun doesn't hot-reload.
- **Per-repo init:** a repo can ship `.kobe/init.sh` (runs before the engine, in the worktree) + `.kobe/init-prompt.md` (the engine's first message); repo files win over the per-user state.json override. Mechanics: [`src/state/repo-init.ts`](./packages/kobe/src/state/repo-init.ts).
- **Reference repos** (`refs/`, gitignored, **read-only**): clone before development — what each is for + when to consult lives in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §2.

```bash
mkdir -p refs && cd refs
ln -s /Users/jacksonc/i/agent-deck agent-deck   # if you have it locally
git clone --depth 1 https://github.com/winfunc/opcode.git
git clone --depth 1 https://github.com/tanbiralam/claude-code.git
git clone --depth 1 https://github.com/sirmalloc/ccstatusline.git
git clone --depth 1 https://github.com/openai/codex.git
git clone --depth 1 https://github.com/friuns2/codexui.git
git clone --depth 1 https://github.com/warpdotdev/warp.git
# conductor is image-only — see docs/DESIGN.md §1
```

## Work tracking — local only

No Linear. Backlog/open issues live in the daemon-owned issue store (web Issues page or `kobe api issue-*`, see [`docs/WORK-TRACKING.md`](./docs/WORK-TRACKING.md)); shipped behavior in [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md) (one Changeset per change, see [`docs/RELEASING.md`](./docs/RELEASING.md)); current risks/follow-ups in [`HANDOFF.md`](./HANDOFF.md); durable design decisions as Markdown in `docs/`. If a requirement needs external tracking, surface it first instead of filing it automatically.

## Hard rules (non-negotiable)

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

### Don't touch
- `refs/` — read-only study material, forever.
- Other agents' worktree slices — coordinate via the orchestrator.
- Workspace-level config (`/Users/jacksonc/i/CLAUDE.md`, global git config, etc.).

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
