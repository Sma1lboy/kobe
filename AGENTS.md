# kobe (codename, rename later)

## Project at a glance

kobe is a local-first terminal UI for running many AI coding sessions at once. It takes Conductor's multi-task orchestration shape — task sidebar, workspace chat/files tabs, file tree, embedded terminal, status bar — and makes it terminal-native with git worktrees and local engine processes.

The product unit is:

```text
Task = git worktree + engine session + branch
```

The TUI is the product. Engine adapters are execution backends. Claude Code is the original/default engine, and Codex support exists behind the same engine-owned contract. Neutral layers must ask the engine registry/adapter for product identity, model capabilities, history, telemetry, and mode labels instead of hard-coding vendor strings.

This file is an operator manual for agents. Keep it stable: do not duplicate long release manifests here. For the exact current version and shipped feature list, read [`packages/kobe/package.json`](./packages/kobe/package.json) and [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md).

**Read in order before doing anything**:
1. [`HANDOFF.md`](./HANDOFF.md) — freshest session handoff, current risks, open follow-ups. **Local + gitignored** (per-environment scratchpad, not shared history); may be absent on a fresh clone — that's fine, just skip it.
2. [`docs/DESIGN.md`](./docs/DESIGN.md) — design philosophy, architecture decisions, tech stack lock-in.
3. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — current source-tree map and ownership boundaries.
4. [`docs/PLAN.md`](./docs/PLAN.md) — Phase 0 → Phase 1 stream/wave plan and gate history.
5. [`docs/HARNESS.md`](./docs/HARNESS.md) — agent self-test contract. **Load-bearing.**
6. [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md) — pane-scope rules + boundary patterns. Read before adding/moving any chord.
7. [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md) — current shipped behavior and release-note style.

The architecture decisions are not always obvious from the code. The docs above are the source of truth; if docs and implementation disagree, surface the mismatch before widening scope.

## Conventions

- **Monorepo layout (Bun workspaces).** Source lives under `packages/`:
  - [`packages/kobe/`](./packages/kobe) — the TUI itself, published as `@sma1lboy/kobe`. All `src/...`, `test/...`, `scripts/...` paths in docs are relative to here.
  - [`packages/branding/`](./packages/branding) — Remotion render pipeline for `docs/assets/brand/`. Private workspace.
  - Run package scripts via `bun --filter @sma1lboy/kobe <script>` or `cd packages/kobe && bun <script>`.
  - Repo-wide tools at root: `biome.json`, `bun.lock`, `.github/workflows/`, `docs/`, `AGENTS.md`, `CLAUDE.md` (symlink), `HANDOFF.md`.
- `refs/` contains study material (symlinks + clones), **gitignored**. **Never edit anything inside `refs/`.**
- Respond in whatever language the current user is writing in. Don't assume their name — let them introduce themselves.
- Tech stack is locked: **TypeScript + `@opentui/core` + `@opentui/solid` + Solid.js + Bun**. Do not re-litigate.

## Development environments

Two flavours of `bun run dev:*` (runnable from the repo root or `packages/kobe/`) — the `dev:test` / `DevAIEngine` fake-engine flavour is gone (deleted with the headless engine in v0.6):

| Script | Engine | Home dir | Use when |
|---|---|---|---|
| `dev` | Real `claude` / `codex` | `~/.kobe` (production) | Touching production-style state. |
| `dev:sandbox` | Real `claude` / `codex` | `packages/kobe/.dev-sandbox/home` (empty, throwaway) | Worktree-based dev where you want a real engine but must not touch the production `~/.kobe/tasks.json`. Reset with `bun run dev:sandbox:reset`. |

Each gets its own daemon socket + pidfile under its respective `KOBE_HOME_DIR`, so both can coexist. `defaultDaemonSocketPath` honours an explicit `KOBE_HOME_DIR` ahead of `XDG_RUNTIME_DIR`. The **tmux server** is isolated the same way: the socket name comes from `KOBE_TMUX_SOCKET` (default `kobe`), and `dev:sandbox` sets `KOBE_TMUX_SOCKET=kobe-sandbox` so its task sessions never share a server with production. `bun run dev:sandbox:reset` (`kobe kill-sessions` on the sandbox socket) tears down only the sandbox sessions — use it after Tasks-pane / Ops-pane / engine changes so a long-lived session isn't still running old pane code. `kobe kill-sessions` with no env override targets the default `kobe` socket (production) — destructive, so reserve it for an intentional prod reset.

### Daemon logs & crash net

The daemon is a long-lived background process. Two pieces of infrastructure keep it debuggable instead of "dying silently" (KOB-193):

- **Crash net** — `installDaemonCrashHandlers()` ([`src/daemon/crash-log.ts`](./packages/kobe/src/daemon/crash-log.ts)) registers `unhandledRejection` / `uncaughtException` handlers in the daemon process. A stray async rejection is **logged, not fatal** — the daemon keeps serving. Without this, any `void someAsync()` that rejected terminated the whole daemon (Node/Bun default).
- **Log file** — the detached daemon's stdout/stderr are redirected to `<KOBE_HOME>/.kobe/daemon.log`, not `/dev/null`. **When a daemon problem is reported, read that log first** — it carries the stack and a `[subsystem]` tag.

When adding a fire-and-forget daemon call (`void someAsync()`), attach `.catch((err) => logDaemonError("<subsystem>", err))` so a failure is pinned to its subsystem (`[plan-usage-poller]`, `[daemon-shutdown]`, …) instead of surfacing as an anonymous rejection. Crash handlers are installed only in the real daemon process (`cli/daemon-cmd.ts` `start` branch) — never from code shared with the TUI or tests, since they mutate global `process` state.

### Daemon lifecycle: refcounted lazy shutdown

The daemon's lifetime is bound to the number of **attached GUIs** — a front-end that subscribed with `role: "gui"`. The refcount lives in [`src/daemon/server.ts`](./packages/kobe/src/daemon/server.ts) (`guiCount()` + an idle grace timer):

- **`subscribe` carries a role** — `gui` vs `pane` ([`SubscribeRole`](./packages/kobe/src/daemon/protocol.ts)). Only `gui` HOLDS the daemon alive. A `gui` is a real front-end attach: the `kobe` process parked on `tmux attach` ([`tui/direct.ts`](./packages/kobe/src/tui/direct.ts)) or the deprecated outer monitor ([`tui/app.tsx`](./packages/kobe/src/tui/app.tsx)). Everything else subscribes as `pane` — the default — and gets push channels without keeping the daemon up.
- **Why the split** (the bug it fixes): in the tmux-native model each ChatTab is a tmux window with its own kobe-owned panes (Tasks pane, Ops, settings/new-task windows), and each pane subscribes for live data. Those panes **outlive the attach** — the tmux session persists after the user quits kobe. When *every* subscriber counted, N ChatTab windows meant N Tasks panes still subscribed, so the count never reached 0 on quit and the daemon never idle-stopped. `RemoteOrchestrator` defaults to `role: "pane"`; only `direct.ts` / `app.tsx` pass `role: "gui"`.
- **First GUI launches** → `ensureDaemonReachable` auto-spawns the daemon if the socket isn't answering. Multiple TUIs share the one daemon.
- **Last GUI quits** → on the `>0 → 0` gui transition the daemon arms a grace timer (`KOBE_DAEMON_IDLE_GRACE_MS`, default **3s**), then self-stops via the existing `stopSoon()` path. The grace absorbs reconnect blips (e.g. `manualReconnect()` force-drops then re-subscribes); a `gui` re-subscribe inside the window cancels it — a `pane` subscribing mid-grace does **not** rescue the daemon.
- **Quitting a TUI doesn't RPC the daemon to die** — closing the gui socket is enough; the refcount drives shutdown. Ctrl+Q is `focus.sidebar`, not quit; real quit is `q` (sidebar) / `Ctrl+C`×2.

Two deliberate non-triggers, so the count only ever reflects real GUIs:
- **Transient CLI pokes never subscribe (or subscribe as `pane`)** — `daemon status` / `daemon stop` / `daemon restart` and any `hello`-only client don't bump the count; `kobe api`'s one-shot `subscribe()` is a `pane`. None can trip shutdown.
- **The timer never arms on boot** — only on a `>0 → 0` transition. A foreground `kobe daemon start` or a freshly-respawned `kobe daemon restart` daemon (both gui-less by design) stay up.

**Rule when you add a new subscribing surface.** Any new in-session pane/window that talks to the daemon (a new `kobe <pane>` host, a dialog window, a CLI poke) must subscribe as `role: "pane"` — which is the default, so just *don't pass a role*. `role: "gui"` is reserved for the one process whose lifetime equals "a human is attached and looking at kobe" (today: `direct.ts`, plus the deprecated `app.tsx` monitor). The failure mode if you get this wrong is silent and only shows up with multiple ChatTabs: a stray `gui` (or counting `pane`s) keeps the daemon alive after quit; a missing `gui` lets the daemon idle-stop while a human is still attached. When unsure, it's `pane`.

**Shutdown never touches tmux.** `server.close()` tears down sockets/pidfile only; task tmux sessions outlive the daemon and are re-adopted on the next launch. The *only* tmux teardown path stays `kobe reset` / `kobe kill-sessions` (`tmux -L kobe kill-server`) — see below. Don't couple tmux kills into daemon shutdown.

### Packaged-build recovery: `kobe doctor` / `kobe reset` (KOB-258)

`dev:sandbox:reset` is dev-only. The packaged answer to "the daemon wedged/died, reset it" is two top-level commands in [`src/cli/maintenance.ts`](./packages/kobe/src/cli/maintenance.ts):

- **`kobe doctor`** — read-only diagnosis. Reports daemon state (running / WEDGED = process alive but not answering / stale pidfile / not running), tails `daemon.log` when down, counts kobe tmux sessions, and lists `tasks.json` / `state.json` / `daemon.log`. Never mutates — it only recommends the fix.
- **`kobe reset [--hard] [--yes]`** — stop the daemon, remove its socket + pidfile, kill all kobe tmux sessions. `--hard` also wipes the task index + UI state. Never touches worktrees; confirms on a TTY; does not respawn (relaunch kobe).

The wedge these exist for: `startDaemonServer` unlinks the socket before `listen`, so a stale socket *file* is harmless — the real trap is an OLD daemon still alive but not servicing the socket, which a fresh launch races by stealing the socket → two daemons on one `tasks.json`. The graceful → SIGTERM → SIGKILL kill that makes the old one go away lives once in [`src/daemon/lifecycle.ts`](./packages/kobe/src/daemon/lifecycle.ts) `stopDaemonProcess()`, shared by both `reset` and `kobe daemon restart`.

## Per-repo init script + first prompt

Each repo can define setup that runs for **every** worktree, so a new task needs no manual init. Two pieces, resolved per field by [`src/state/repo-init.ts`](./packages/kobe/src/state/repo-init.ts) `resolveRepoInit(repoRoot, worktreePath)`:

- **init script** — shell run BEFORE the engine starts, in the worktree.
- **init prompt** — the engine's FIRST message, pasted once it's ready.

Two sources, **repo files win per field** (the committed `.kobe/` files are the project's authoritative setup; the state.json override is a per-user fallback default for a repo that ships neither):

1. In-repo, checked out in the worktree: `<worktree>/.kobe/init.sh` and `<worktree>/.kobe/init-prompt.md`.
2. Per-user state.json override (`repoConfigs[repoRoot]`), set via `kobe repo set/show/unset` ([`src/cli/repo-cmd.ts`](./packages/kobe/src/cli/repo-cmd.ts), storage in [`src/state/repos.ts`](./packages/kobe/src/state/repos.ts) `getRepoInitOverride`/`setRepoInitOverride`).

Load-bearing mechanics, don't regress them:

- **Same shell, not a subshell.** The init script is woven into pane 0's launch line by [`session-layout.ts`](./packages/kobe/src/tmux/session-layout.ts) `engineLaunchLine` as a `{ …; }` brace GROUP — so `export`s reach the engine — NOT `( … )` (which would swallow them).
- **Once per worktree.** A marker under `<home>/.kobe/worktree-init/<hash>` ([`env.ts`](./packages/kobe/src/env.ts) `worktreeInitMarkerPath`) gates re-runs; it lives outside the worktree so it never dirties git, and is touched only on `$? -eq 0` so a failed init retries next launch. Trade-off of "once per worktree": an env-setting init does NOT re-apply on an in-place vendor-switch respawn (the marker exists) — a full kill+rebuild does re-evaluate it via the create path.
- **First prompt = fresh sessions only.** It's delivered from `ensureSession`'s create branch (fire-and-forget via [`prompt-delivery.ts`](./packages/kobe/src/tmux/prompt-delivery.ts) `deliverFirstPrompt`), so a re-attach never re-sends it. `kobe api …  --prompt` runs the init script but delivers the explicit prompt instead of the repo's first prompt (no double paste).

Resolution happens at the `ensureSession` call sites that have the Task (`direct.ts`, `tasks-pane/host.tsx`, `fullscreen.tsx`, `api-cmd.ts`); `EnsureSessionOpts.initScript`/`initPrompt` only take effect on a fresh build, so passing them on a reuse call is harmless.

## Reference repos — clone before development

kobe is built by deliberately copying ideas (and sometimes code) from reference projects. New devs / agents must have these refs cloned into `refs/` before touching the codebase. Run the setup block below; agents who skip this miss design context that's not derivable from the kobe source alone.

| `refs/` slot | Source | Borrowed surface |
|---|---|---|
| `agent-deck` | [`/Users/jacksonc/i/agent-deck`](https://github.com/sma1lboy/agent-deck) (symlink) | **TUI visual style + layout grammar.** Pane chunking, agent-deck-style `[Tab] label` chip hotkeys, BOLD CAPS pane headers, status-line bottom bar, focused-pane border highlighting. When in doubt about how a pane should look, open `agent-deck` and look at how it solves the same problem. |
| `conductor` (image only) | screenshots Jackson supplied | **Layout + product capability brief.** The 5-pane Conductor screenshot in `docs/DESIGN.md` §1 is the layout grammar. We don't have source access; we copy the chunking + capability set (multi-task, history sidebar, file tree, terminal, chat). Direction shifting per-session — see HANDOFF.md. |
| `opcode` | fresh clone of [`winfunc/opcode`](https://github.com/winfunc/opcode) | **How to spawn + stream Claude Code as a subprocess.** kobe's `packages/kobe/src/engine/claude-code-local/` was algorithmically ported from opcode's `src-tauri/src/commands/claude.rs` (subprocess spawn + stream-json parser + JSONL reader + binary discovery). When extending the engine, port from opcode first. |
| `claude-code` | fresh clone of [`tanbiralam/claude-code`](https://github.com/tanbiralam/claude-code) (leaked Anthropic source, March 2026) | **Match Claude Code's exact stream rendering style.** Has `src/ink/` (the Ink-based TUI components, layout, events). When implementing how the stream output looks (assistant text formatting, tool call display, thinking dots, code blocks, citations), mirror Claude Code's choices so kobe feels like Claude Code, not a third-party shell. |
| `ccstatusline` | fresh clone of [`sirmalloc/ccstatusline`](https://github.com/sirmalloc/ccstatusline) | **Status/context/speed derivation reference.** Reads Claude Code's `transcript_path` JSONL and status JSON to derive token totals, context-window usage, compaction hints, and input/output/total token speed. Use it before changing kobe's context meter, plan/status chips, or any transcript-derived usage metric. |
| `codex` | fresh clone of [`openai/codex`](https://github.com/openai/codex) | **Official Codex CLI / engine behavior reference.** Use before changing `packages/kobe/src/engine/codex-local/`: spawn flags, `exec --json` event shapes, resume/session semantics, app-server protocol, auth behavior, sandbox/approval options, model reasoning controls, and transcript/session storage. |
| `codexui` | fresh clone of [`friuns2/codexui`](https://github.com/friuns2/codexui) | **How to drive the `codex` CLI / app-server from another process.** Browser bridge for `codex app-server` (richer RPC than the `codex exec --json` path kobe's `engine/codex-local/` uses today). Consult when extending codex support — auth/login flows, app-server features the exec path can't reach, or matching their normalization choices. |
| `warp` | fresh clone of [`warpdotdev/warp`](https://github.com/warpdotdev/warp) | **Terminal-native workflow and UI reference.** Use when comparing terminal task/session UX, command surfaces, keyboard-first flows, and pane/split ergonomics against a polished terminal product. |

### Setup before developing

```bash
mkdir -p refs && cd refs
ln -s /Users/jacksonc/i/agent-deck agent-deck   # if you have it locally
git clone --depth 1 https://github.com/winfunc/opcode.git
git clone --depth 1 https://github.com/tanbiralam/claude-code.git
git clone --depth 1 https://github.com/sirmalloc/ccstatusline.git
git clone --depth 1 https://github.com/openai/codex.git
git clone --depth 1 https://github.com/friuns2/codexui.git
git clone --depth 1 https://github.com/warpdotdev/warp.git
# `conductor` is image-only — read docs/DESIGN.md §1 for the layout
```

`refs/` is gitignored, so each environment clones for itself. CI / agent runs that need ref reading should mirror this setup or surface a missing-ref error, not silently proceed with partial context.

### When to consult which ref

- "How should this pane look?" → `agent-deck`.
- "What feature is missing from kobe vs Conductor?" → `docs/DESIGN.md` §1 + Jackson's screenshots.
- "How do I spawn / parse / resume a Claude Code session?" → `opcode/src-tauri/src/commands/claude.rs`.
- "How does Claude Code render <X>?" (where X = stream content, tool call display, prompt formatting, etc.) → `claude-code/src/ink/`.
- "How should status/context/speed be derived from Claude Code data?" → `ccstatusline/src/ccstatusline.ts`, `ccstatusline/src/utils/jsonl-metrics.ts`, and `ccstatusline/src/utils/context-window.ts`. Important pattern: speed is not a field Claude Code hands over; it is derived by reading the conversation JSONL (`transcript_path`), pairing user/assistant timestamps, and dividing token usage by active request duration.
- "How should kobe match official Codex CLI behavior?" → `codex/` first. Treat this as authoritative for `codex exec --json`, `codex app-server`, auth/session storage, sandbox/approval modes, model reasoning options, and event schemas.
- "How do I drive `codex` from another process / normalize its events / handle auth?" → `codexui/src/server/` + `codexui/src/api/`. Their bridge speaks `codex app-server` RPC, not `codex exec --json`; port ideas, not architecture.
- "How should terminal-native task/session UX compare to a polished terminal product?" → `warp/`.

If a ref disagrees with kobe's existing implementation, kobe wins (we already chose) — but read the ref before deciding to deviate further.

## Work tracking — local only

kobe work is maintained locally. Do not create Linear issues, update Linear states, or require `linear` CLI authentication as part of normal agent work.

Use local artifacts instead:

- Backlog + open issues live in [`docs/issues.json`](./docs/issues.json) — one JSON, `status` only (`open`/`doing`/`done`), `done` swept to `issues-archive.json` via `bun run issues:archive`. See [`docs/WORK-TRACKING.md`](./docs/WORK-TRACKING.md).
- Code changes are tracked by git commits.
- User-facing shipped behavior is tracked in [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md) (one Changeset per change — see [`docs/RELEASING.md`](./docs/RELEASING.md)).
- Current risks and follow-ups are tracked in [`HANDOFF.md`](./HANDOFF.md).
- Durable design decisions belong in `docs/` as Markdown.

If a future requirement needs external tracking, surface it to the user first instead of filing it automatically.

## Hard rules (non-negotiable)

### Commits

- Commit at the end of each stream when the agent is green. The user has authorized per-stream commits in advance.
- Commit message: `<type>: <stream id> — <one-line summary>` plus a 2-3 sentence body.
- **NEVER** include `Co-Authored-By: Claude` or any AI/Anthropic/Claude attribution. No "Generated with Claude Code" footers. (From the workspace-level `/Users/jacksonc/i/CLAUDE.md`.)
- **NEVER** use `--no-verify`, `--no-gpg-sign`, or skip hooks. If a hook fails, fix the underlying issue.

### Releases

- **Changeset bump is `patch` by default.** Every changeset uses `patch` unless the user EXPLICITLY says this one is a `minor` (or `major`) in that turn. Do not infer `minor` from "it's a feature" / new commands / new API surface — pre-1.0 kobe ships features as patches; only an explicit instruction promotes the bump.
- When cutting a version, the release notes / CHANGELOG section may include a short thank-you line for human developers, contributors, testers, or users who helped shape the release.
- Keep thanks product-facing and human-facing. Do not add AI, Anthropic, Claude, Codex, or tool-generated attribution, and do not add attribution footers to commits or tags.

### Deletion

- **NEVER** delete files, branches, worktrees, or run `rm -rf` unless the user explicitly says "delete" or "remove" *in the same conversation turn*.
- This includes: cleanup of stale worktrees, "fixing" the layout by removing files, anything destructive.
- If a task seems to require deletion, surface and ask first.

### Scope

- A stream agent only edits files within its declared slice. Cross-stream changes are surfaced, not silently made.
- 3-strike rule: same root cause failed three times → stop and surface.
- Max-depth rule: 3+ levels of sub-investigation → surface findings before going deeper.

### Don't touch

- `refs/` — study material, read-only forever.
- Other agents' worktree slices — coordinate via the orchestrator.
- Workspace-level config (`/Users/jacksonc/i/CLAUDE.md`, global git config, etc.).

### Layout: flex-first, hardcode last

opentui boxes follow Yoga flexbox semantics. Default to flex flow (`flexGrow`, `flexShrink`, `flexBasis`, `flexDirection`) for sizing — let panes share available terminal width by ratio, not by pixel-count. Hardcoded `width={N}` / `height={N}` is acceptable only when:

- **Convention** — e.g. the task/sidebar rail's 12-cell width matches kobe's compact tmux Tasks pane. Document the reason inline.
- **Terminal-grammar fixed glyph** — e.g. a 2-cell column for diff-line `+`/`-` markers.
- **Modal or transient overlay** — dialogs centered with computed dimensions.

Never use `width={N}` / `height={N}` to express "this pane should be this big proportionally." Use `flexGrow={N}` for that. Avoid `height="100%"` — `flexGrow={1}` does the same thing without surprising clipping when the parent doesn't have an explicit height.

If you find yourself reaching for a magic constant: pause, and verify a flex prop wouldn't do the same thing.

### Engine-owned UI data

The engine adapter is the source of truth for **agent/product identity, capabilities, history, and telemetry**. As kobe supports more than one engine, neutral layers must not hard-code Claude/Codex-specific strings or derive vendor-specific metrics themselves.

- Product/name copy comes from `AIEngine.identity` / the engine registry (`productName`, `shortName`, `assistantName`, `inputPlaceholder`). Example: the chat composer says `Ask ${engine.shortName}` via engine-owned data, not a literal `"Ask Claude…"`.
- Model catalogs and context-window math come from `EngineCapabilities`, keyed by the task's vendor when available. Do not infer a task's vendor solely from a model id unless the task has no vendor.
- Persisted history is returned as an engine-owned `EngineHistory` (`messages` + `usageMetrics`). Claude Code may derive this from `~/.claude/projects/*.jsonl`; Codex may derive it from `~/.codex/sessions/**/rollout-*.jsonl`; callers should not know either format.
- Token usage, context usage, and speed are engine-normalized data. The TUI may format `usageMetrics` for display, but it should not parse vendor transcript files or reconstruct speed from chat timestamps.
- Subagent (Agent/Task) steps are engine-owned **nested** data, not transcript noise. The engine tags a subagent's internal tool events with a `parentId` (`EngineEvent.tool.start` / `tool.result`); the chat nests them under the parent Agent row's `children` rather than flattening them into the top-level transcript. A subagent's prose / `system` / terminal `result` are NOT surfaced — only its tool steps. kobe nests one level: deeper (grand-child) subagent steps are dropped at the parser, never mis-attached. History-replay nesting is KOB-177.
- If a new pane needs engine-specific data, extend the engine contract first. Do not thread ad hoc vendor checks through TUI or orchestrator code.

### Diagrams in `docs/`: use Mermaid

When a `docs/` markdown file needs a diagram (entity relationships, state machines, lifecycles, sequence flows), use **Mermaid** in a ` ```mermaid ` fence rather than ASCII art.

Why Mermaid and not PlantUML / vega / canvas / etc.: Mermaid renders **natively in GitHub README, GitHub PR previews, and VS Code's built-in markdown preview** — zero plugins, zero servers. PlantUML and the other markdown-viewer formats need a browser extension or a local renderer, which means most viewers see a code block of unrendered source. Diagrams should be legible to anyone clicking a `.md` link in the repo.

ASCII boxes are fine for tiny relationships (≤3 nodes, no states), but rot the moment a state or arrow is added. When in doubt, reach for Mermaid.

Canonical example: [`docs/design/tasks.md`](./docs/design/tasks.md) — `classDiagram` for the Task / Worktree / ChatTab triple, `stateDiagram-v2` for the tab and task lifecycles.

## Phase status

- **Phase 0**: foundation. Streams 0.1 (bootstrap, solo), then Foundation Team (0.2 + 0.3 + 0.4) in parallel. **Closed.**
- **Phase 1**: build the 5-pane Conductor-shaped TUI. Waves 1–4 per `docs/PLAN.md`. **Closed at gate G4 on 2026-05-09 — shipped as `@sma1lboy/kobe@0.1.0` on npm.** The post-0.1 line is release-driven now; do not summarize the latest feature set here. Read [`packages/kobe/package.json`](./packages/kobe/package.json) for the package version and [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md) for the canonical shipped behavior.
- **Phase 2**: dropped 2026-05-09. Originally a defensive hedge for "what if we ever swap engines." No real product driver — kobe's value is the UI, the local `claude` subprocess works, and Anthropic's API already covers shared/cloud sessions. Free up the design space; revisit only if a concrete engine-swap need surfaces.

Update this section only when a phase/gate changes. Do not update it for every patch release; changelog owns that.

### Closed follow-ups from 0.1.0

- Approval-flow regressions resolved (commit `0c73ebb`): the
  AskUserQuestion "crash" was a UTF-8 byte/char mismatch in the test
  helper's `Content-Length` header (em-dash in the question payload),
  not a kobe crash. The composer-lock failure was an over-strict test
  assertion — opentui's text wrapper drops the space at a wrap point,
  so the rendered placeholder is `answerthe promptabove to continue`.
  Both `packages/kobe/test/behavior/approval-flow.test.ts` cases now run.
- CI gate: `.github/workflows/ci.yml` runs typecheck + unit tests + build
  on every push to main and every PR. `bun run test` is split into fast
  Vitest coverage plus the Unix-socket daemon/bridge suite. Behavior
  tests stay local-only and opt-in via `bun run test:behavior` (need tmux
  + node-pty terminal sizing). Do not loop on `test:behavior` unless the
  change is user-visible or the behavior harness itself is the target.
