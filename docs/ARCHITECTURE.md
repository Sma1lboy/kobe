# kobe — Architecture

> Map, not territory. If you've never seen the codebase, read this in 10 minutes
> and you should know "where does X live, and why is it there." For the *why* of
> the design choices, read [`DESIGN.md`](./DESIGN.md). For the *how it got built*,
> read [`PLAN.md`](./PLAN.md). For the *self-test contract*, read
> [`HARNESS.md`](./HARNESS.md). This document is a tour of the source tree as it
> currently stands.

> **Path convention.** kobe is a Bun-workspaces monorepo. The TUI/CLI
> package lives at `packages/kobe/`; daemon-owned code lives at
> `packages/kobe-daemon/`. Unless a path is package-qualified, `src/...`,
> `test/...`, and `scripts/...` paths in this doc are relative to
> `packages/kobe/`. The branding workspace, `packages/branding/`, is the
> Remotion render pipeline for the brand artwork in `docs/assets/brand/`
> and isn't covered here.

## Contents

1. [The layer cake](#1-the-layer-cake)
2. [Reference projects under `refs/`](#2-reference-projects-under-refs)
3. [Outer monitor and tmux workspace](#3-outer-monitor-and-tmux-workspace)
4. [Daemon ↔ task-session seam](#4-daemon--task-session-seam)
5. [Test harness](#5-test-harness)
6. [Persistence: where state lives on disk](#6-persistence-where-state-lives-on-disk)
7. [What's deliberately NOT in kobe](#7-whats-deliberately-not-in-kobe)
8. [Recipes — how to add X](#8-recipes--how-to-add-x)

---

## 1. The layer cake

Four layers, top→bottom. Higher layers depend on lower; lower layers know
nothing about higher.

```
┌────────────────────────────────────────────────────────────────┐
│  TUI clients + panes  (Solid + @opentui/solid + @opentui/core) │
│   src/tui/{direct.ts, tasks-pane/, ops/, panes/, context/}    │
├────────────────────────────────────────────────────────────────┤
│  RemoteOrchestrator  (client facade over daemon RPC + channels)│
│   src/client/remote-orchestrator.ts                            │
├────────────────────────────────────────────────────────────────┤
│  Daemon  (single writer for task index)                        │
│   packages/kobe-daemon/src/daemon/{server.ts,...}              │
│   packages/kobe-daemon/src/client/                             │
├────────────────────────────────────────────────────────────────┤
│  Orchestrator + tmux handover                                  │
│   src/orchestrator/{core.ts,worktree/,index/}                  │
│   src/tmux/{client.ts,session-layout.ts}                       │
├────────────────────────────────────────────────────────────────┤
│  Types + engine-adapter helpers                                │
│   src/types/{task.ts,worktree.ts,index.ts,vendor.ts}           │
│   src/engine/*/{history,normalize,hook-adapter}.ts             │
└────────────────────────────────────────────────────────────────┘
```

The seams matter:

- **The Daemon is the task-index writer.** TUI clients and in-tmux panes
  mutate tasks through daemon RPC and hydrate from daemon channels. Direct
  writes to `TaskIndexStore` from UI code are a leak.
- **The Orchestrator is task lifecycle only.** It owns task metadata,
  worktree allocation, ordering, active-task touch timestamps, and the
  reactive task-list signal. It does not spawn or stream an engine process.
- **tmux owns interactive engine processes.** Entering a task is a
  Handover: kobe ensures the Worktree and tmux Session, suspends the outer
  renderer, and attaches the user's real TTY. Engine-specific code in
  `src/engine/` is now Adapter support for commands, hook normalization,
  history/usage readers, and account/model discovery.
- **Panes never reach past the daemon facade for task writes.** Outer TUI
  panes use `RemoteOrchestrator`; in-tmux helper panes subscribe as daemon
  `role: "pane"` so they receive task snapshots without pinning daemon
  lifetime.
- **opentui is infrastructure, not architecture; Solid signals are a
  shared reactive primitive.** The orchestrator must not depend on
  opentui or anything that renders — that's the seam the daemon split
  hangs on (see [`design/daemon.md`](./design/daemon.md) §9 D0). Solid
  signals are deliberately allowed inside the orchestrator: they're a
  pure in-process reactive primitive with no DOM / no opentui coupling,
  and the TUI consumes the same primitive so panes can subscribe
  without an adapter layer. Whenever a pane needs to *do* something
  stateful (run a task, switch tabs, persist), it still goes through
  the orchestrator — signals are wiring, not the source of truth.

### File ownership cheat sheet

| Concern | Owner |
|---|---|
| Daemon server, protocol, event bus, lifecycle, paths | `packages/kobe-daemon/src/daemon/` |
| Low-level daemon socket client + autostart helper | `packages/kobe-daemon/src/client/` |
| Remote task facade used by TUI clients | `src/client/remote-orchestrator.ts` |
| Interactive engine command selection | `src/engine/interactive-command.ts` |
| Engine hook normalization | `src/engine/*/hook-adapter.ts` + `src/engine/hook-events.ts` |
| Reading historical JSONL | `src/engine/claude-code-local/history.ts` |
| Finding the `claude` binary | `src/engine/claude-code-local/binary.ts` |
| Task lifecycle | `src/orchestrator/core.ts` |
| Per-task tmux Session layout | `src/tmux/session-layout.ts` + `src/tui/panes/terminal/tmux.ts` |
| Handover attach/detach | `src/tui/direct.ts` |
| `git worktree` wrapper | `src/orchestrator/worktree/manager.ts` |
| Worktree path convention | `src/orchestrator/worktree/paths.ts` |
| Task index on disk | `src/orchestrator/index/store.ts` |
| ULID generator | `src/orchestrator/index/ulid.ts` |
| PR prompt rendering | `src/orchestrator/pr/build.ts` |
| TUI bootstrap | `src/tui/index.tsx` (straight to `direct.ts`) |
| Pane focus | `src/tui/context/focus.tsx` |
| Global keybindings | `src/tui/context/keybindings.ts` |
| KV (per-user UI state) | `src/tui/context/kv.tsx` |
| Theme (palettes + active theme) | `src/tui/context/theme.tsx` + `src/tui/context/theme/*.json` |
| Daemon socket/integration tests | `test/daemon/*.test.ts` |
| Unit-test type assertions | `test/types/*.test-d.ts` |

### Web transport (daemon-owned)

The browser dashboard talks directly to a daemon-hosted loopback HTTP/SSE
transport in `packages/kobe-daemon/src/daemon/web-server.ts`. ADR 0003
reversed the old "web routes live outside the daemon" decision: daemon-backed
browser data and mutations now share the daemon handler registry, event bus,
and lifetime policy instead of crossing a standalone `kobe-web/server` bridge.

Current daemon web responsibilities:

- Browser state hydrates from a daemon-built `snapshot`, then receives daemon
  channel pushes as SSE `channel` events. An open browser SSE stream counts as
  a GUI lifetime hold, so normal lazy-shutdown rules still apply.
- Browser mutations go through `/api/rpc`, which dispatches to the daemon RPC
  registry through an explicit web allowlist. Connection-scoped and lifecycle
  verbs (`hello`, `subscribe`, `daemon.stop`) are not browser-reachable.
- Session/launch-spec routes (`/api/session`, `/api/engine-spec`,
  `/api/terminal-spec`) live on the daemon web transport so the PTY sidecar can
  fetch launch details without a separate adapter process.
- Web-specific route helpers (`packages/kobe/src/web/notes.ts`,
  `packages/kobe/src/web/diff.ts`, `packages/kobe/src/web/history.ts`,
  `packages/kobe/src/web/themes.ts`) remain feature modules consumed by the
  daemon web transport. They are not a second daemon, and they must not keep
  their own task/event cache.
- Web dev (`packages/kobe-web/dev.ts`) runs only Vite plus the Node PTY
  sidecar; Vite proxies `/api` and `/events` to the daemon web port. Desktop
  uses the same path.

Rule: add new daemon-backed browser behaviour to the daemon web interface
first. Do not add new product behaviour to the legacy `kobe-web/server` bridge
adapter.

---

## 2. Reference projects under `refs/`

`refs/` is gitignored study material. **Never edit anything inside it.** Each
contributor clones it locally per the setup block in `AGENTS.md` (`CLAUDE.md`
is a symlink). The slots and what each one teaches kobe:

| `refs/` slot | Source | What kobe borrows from it |
|---|---|---|
| `agent-deck` | symlink to Jackson's local repo | TUI visual grammar — pane chunking, `[Tab] label` chip hotkeys, BOLD CAPS pane headers, focused-pane border highlighting |
| `conductor` | screenshots only — no source | The 5-pane layout grammar (sidebar / workspace / files / preview / terminal) — see DESIGN.md §1 |
| `opcode` | clone of `winfunc/opcode` | Subprocess wrapping for Claude Code — kobe's `src/engine/claude-code-local/` was algorithmically ported from `opcode/src-tauri/src/commands/claude.rs` |
| `claude-code` | clone of `tanbiralam/claude-code` (leaked Anthropic source) | Render parity — match Claude Code's text formatting, tool display, citations exactly. See `src/ink/` in the ref |
| `ccstatusline` | clone of `sirmalloc/ccstatusline` | Status/context/speed derivation — especially transcript JSONL usage parsing, context-window math, and token-speed calculations |
| `codex` | clone of `openai/codex` | Official Codex CLI / engine behavior reference |
| `codexui` | clone of `friuns2/codexui` | Driving `codex app-server` from another process |
| `warp` | clone of `warpdotdev/warp` | Terminal-native workflow and pane/session UX reference |

Concrete provenance examples in the kobe source:

- `src/engine/claude-code-local/binary.ts` mirrors opcode's
  `claude_binary.rs` discovery order (PATH → NVM → Homebrew →
  `~/.claude/local`).
- `src/engine/claude-code-local/history.ts` documents the
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` path scheme,
  cross-referenced with opcode.
- `src/engine/*/normalize.ts` and `src/engine/*/usage.ts` are the
  engine-owned transcript/history Adapters; read the relevant upstream ref
  before changing an event or usage interpretation.
- `src/tmux/session-layout.ts` and `src/tui/panes/terminal/tmux.ts` are the
  tmux-native replacement for the removed v0.5 stream pump. Layout/attach
  bugs should be fixed there, not by reintroducing a headless engine loop.
- Usage metrics mirror `refs/ccstatusline/src/utils/jsonl-metrics.ts` by
  deriving token totals and speed from transcript timestamps rather than
  trusting a precomputed speed field.

When two refs disagree with kobe, **kobe wins** (we already chose). But
read the ref before deciding to deviate further.

---

## 3. tmux workspace

The product center is the tmux-native workspace reached by Handover:
`kobe` attaches straight into the active Task's tmux Session
(`src/tui/direct.ts`). The opentui outer monitor (`app.tsx`, with its
Live Preview / Cost Dashboard Workspace) was retired in 2026-06 (the
inventory/decision record `docs/design/app-retirement.md` is in git history). The
Sidebar component (`src/tui/panes/sidebar/` — Working / Archives split,
PROJECTS + TASKS sections, default/recent sort, row-view logic in
`row-view.ts`) lives on inside the Tasks pane.

### tmux ChatTab layout

Each Task owns one tmux Session (`kobe-<task-id>`). Each ChatTab is a tmux
window with kobe-owned helper panes plus the engine pane:

```
┌────────────┬───────────────────────────────────────────────────────┐
│ Tasks pane │ engine CLI (claude / codex / copilot)                 │
│            ├───────────────────────────────────────────────────────┤
│            │ Ops pane / shell                                      │
└────────────┴───────────────────────────────────────────────────────┘
```

The pure layout policy is `src/tmux/session-layout.ts`; the tmux Adapter and
session lifecycle helpers are `src/tmux/client.ts` and
`src/tui/panes/terminal/tmux.ts`. The in-session task list host is
`src/tui/tasks-pane/host.tsx`; Ops/file browsing lives under
`src/tui/ops-pane/` and related tmux helpers.

### Focus + keymap routing

Focus is a single signal: `src/tui/context/focus.tsx`. `useFocus()` exposes
`focused()`, `setFocused(pane)`, `is(pane)`, `cycle(±1)`. The four pane ids
are `"sidebar" | "workspace" | "files" | "terminal"`.

Three rules govern key handling:

1. **Modifier-prefixed keys (`ctrl+1`..`ctrl+4`, `ctrl+n`, `ctrl+k`,
   `ctrl+q`) are always-on** — they never collide with composer typing.
   See `src/tui/context/keybindings.ts`.
2. **Single-letter global shortcuts (`?`, `q`, `tab`) are gated on
   "no input is focused"** — `useKobeKeybindings({ inputFocused })`
   reads the focus signal and omits these registrations whenever the
   workspace pane has an active input/modal surface.
3. **Pane-local bindings (`j/k` in sidebar, `enter` in launchers/lists)
   register inside the pane component** via
   `useBindings()` from `src/tui/lib/keymap.tsx`, scoped to that
   component's lifetime. The pane gates them on `useFocus().is(...)`.

The keybinding registry itself is a stack — dialogs push their own group on
top so `escape` / `enter` apply to the dialog while it's open, not the
underlying pane. See `src/tui/ui/dialog.tsx` for the dialog stack.

---

## 4. Daemon ↔ task-session seam

The current load-bearing contract is the daemon-backed task model plus the
tmux Handover, not a live engine stream. `CONTEXT.md` is the vocabulary
source of truth; this section maps that vocabulary to files.

### Task writes

All task mutations flow through one writer:

```
TUI Client / Tasks pane / kobe web
  └─> RemoteOrchestrator or daemon web transport RPC
        └─> packages/kobe-daemon/src/daemon/server.ts dispatch()
              └─> Orchestrator
                    └─> TaskIndexStore (~/.kobe/tasks.json)
```

`RemoteOrchestrator` keeps a client-side mirror of task state, hydrated by
the daemon's `task.snapshot` channel. UI code should mutate through that
facade or through daemon RPC; importing `TaskIndexStore` from a pane would
bypass the single-writer Module.

### Handover

Entering a task is a tmux attach:

```
Sidebar / Tasks pane select task
  └─> task.setActive (touches updatedAt for recent sorting)
        └─> ensureWorktree(taskId)
              └─> ensureSession(...)
                    └─> Session Layout builds the tmux command graph
                          └─> tmux attach / switch-client
```

`src/tmux/session-layout.ts` is the pure layout policy. The imperative
tmux Adapter is `src/tmux/client.ts` plus `src/tui/panes/terminal/tmux.ts`.
The Handover path must keep tmux teardown out of daemon shutdown: task tmux
Sessions survive daemon restarts and only `kobe reset` / `kobe kill-sessions`
tear down the dedicated tmux server.

### Engine adapters

The engine-specific Modules now support tmux-native sessions instead of
owning them:

| Concern | Path |
|---|---|
| Which command starts the interactive engine | `src/engine/interactive-command.ts` |
| Hook event normalization | `src/engine/*/hook-adapter.ts` + `src/engine/hook-events.ts` |
| Transcript/history reading | `src/engine/*/history.ts` |
| Usage/cost derivation | `src/engine/*/usage.ts` where available |
| Binary/account discovery | `src/engine/*/binary.ts`, `src/engine/account-detect.ts` |

Engine hooks report normalized activity with `engine.reportEvent`; the
daemon folds those into the transient `engine-state` channel. The state is
in-memory UI data, not task lifecycle and not persisted.

### Web transport

`kobe web` is an early experimental front-end over the same daemon. The web
UI owns browser-local workspace tabs. Browser task snapshots, safe task RPC,
engine/terminal launch specs, notes, and diffs are served by the daemon web
transport; ADR 0003 keeps the old kobe-web bridge as transitional source only.
Do not introduce a separate web task cache or a second daemon.

---

## 5. Test harness

Tests aren't just typecheck + unit. The current fast path is pure/unit +
daemon socket coverage; full PTY behavior checks are local opt-in when a
change affects visible terminal flow. See [`HARNESS.md`](./HARNESS.md).

Three test tiers:

| Tier | Lives in | What it proves | Cost |
|---|---|---|---|
| Type-level | `test/types/*.test-d.ts` | The interface shape compiles correctly | ms (tsc) |
| Unit | `test/{engine,orchestrator,tui}/*.test.ts(x)` | Pure logic correct (parsers, stores, reducers) | ~10ms each |
| Daemon/socket | `test/daemon/*.test.ts`, `test/client/*.test.ts` | Wire protocol, lazy shutdown, channel replay, reconnect, web lifecycle | socket-bound |
| PTY behavior | local-only harness per `HARNESS.md` | The product, run end-to-end under a terminal, behaves correctly | slow |

### When to use which tier

- Pure logic? Unit test in `test/{engine,orchestrator,tui}/`. Fast, easy
  to diagnose.
- "Does this daemon channel replay or RPC mutation work?" Socket test under
  `test/daemon/` or `test/client/`.
- "Does this sidebar row state render the right badge?" Unit test the pure
  row-view Module under `test/tui/`.
- "Does the user-visible product respond when I press `n`?" Behavior
  test. There's no substitute.
- Type contract changes? `test/types/*.test-d.ts` with
  `expectTypeOf` — fastest feedback.

---

## 6. Persistence: where state lives on disk

kobe leans on disk locations that already exist (DESIGN.md §2.5). New
state lives in dedicated dirs we own.

| Location | Owned by | Contents |
|---|---|---|
| `~/.kobe/tasks.json` | `TaskIndexStore` (`src/orchestrator/index/store.ts`) | The task manifest — id, title, repo, branch, worktreePath, status, archived flag, vendor/model/settings, ordering, timestamps |
| `~/.kobe/tasks.json.tmp` | `TaskIndexStore` (atomic write) | Transient — written then renamed over `tasks.json` |
| `~/.kobe/<lockfile>` | `src/orchestrator/index/lockfile.ts` | Multi-process safety for the manifest |
| `~/.config/kobe/state.json` | `src/tui/context/kv.tsx` (`KVProvider`) | Per-user UI state — selected theme, transparent-bg toggle, pane sizes, last-open task, expanded sidebar groups |
| `~/.claude/projects/<encoded-cwd>/<sessionUUID>.jsonl` | Claude Code itself; kobe reads via engine history/usage Adapters | Full message history per Session. kobe never writes here. |
| `~/.codex/sessions/**/rollout-*.jsonl` | Codex itself; kobe reads via engine history/usage Adapters | Codex Session history. kobe never writes here. |
| `~/.kobe/worktrees/<repo-key>/<slug>/` | `GitWorktreeManager` (`src/orchestrator/worktree/manager.ts`) | Per-task git worktree for new kobe-created tasks. Convention defined in `src/orchestrator/worktree/paths.ts`; repo-local `<repo>/.kobe/worktrees/<slug>/` and legacy `<repo>/.claude/worktrees/<slug>/` paths remain recognized for existing tasks. |
| `<worktreePath>/.kobe/pr-instructions.md` | Read by `src/orchestrator/pr/instructions.ts` | Optional per-repo override for the PR-creation prompt |

What's deliberately NOT persisted:

- Chat messages (engine transcript files are the source of truth).
- tmux Session process state (tmux owns it; kobe re-adopts by task id /
  session options).
- Engine activity badges (`engine-state`) — transient in-memory daemon UI
  state, replayed to subscribers but never persisted.
- Daemon subscribers, sockets, and web server runtime state.

Backwards compat: older manifests with `sessionId`, `tabs`, or
`activeTabId` are migrated by `TaskIndexStore`.
`TaskIndex.version: 3` is the current shape — see `src/types/task.ts`.

---

## 7. What's deliberately NOT in kobe

DESIGN.md §12 is the authoritative list. Highlights:

| Not in kobe | Where it'd live if we did it | Why we don't |
|---|---|---|
| Conductor-as-backend (was "Phase 2") | A separate daemon/orchestrator Adapter | Dropped 2026-05-09 — no real product driver. |
| Vendor-neutral model abstraction (`@ai-sdk/*` etc) | n/a | kobe runs local interactive engine CLIs. Engine Adapters normalize command launch, hooks, history, usage, and identity; they do not abstract LLM API calls. |
| Cloud sync, multi-machine state | n/a | Local-first. Single developer per machine. |
| Team collaboration | n/a | Single-developer-focused. |
| Plugin system for panes | n/a | Every pane is hardcoded. Pluggability is at the engine layer only. |
| Production web/mobile UI | n/a | The terminal TUI is the product. `kobe web` is early experimental as of 2026-06-09, for local dashboard experiments only. |
| Auto-update mechanism | TopBar shows a chip when a newer version is on npm — see `src/version.ts` — but kobe does not self-install. The chip links to the install command. | Auto-install was deferred from Wave 4. |
| Status state machine in the sidebar UI | The state machine still exists on disk (`Task.status: backlog | in_progress | in_review | done | canceled | error`) — it drives the concurrency cap and is wired through. The sidebar groups by Working / Archives instead of by status. | Conductor-style status grouping was simplified. The 5 status states are kept on disk so the experimental flag can re-introduce the UI later. |

If you find yourself reaching for any of the above, stop and ask first.

---

## 8. Recipes — how to add X

### A new pane

1. Create `src/tui/panes/<name>/` with at least an `index.ts` and a
   component file. Mirror the shape of an existing pane (`filetree/`
   is small and self-contained).
2. Host it as a `kobe <name>` pane host (see `src/tui/ops/host.tsx` /
   `src/tui/tasks-pane/host.tsx`) booted via `bootPaneHost`
   (`src/tui/lib/host-boot.tsx`), and wire it into the Session Layout
   if it belongs in every ChatTab. Subscribe to the daemon as
   `role: "pane"` (the default).
3. Pane-local keybindings register inside the pane component via
   `useBindings()` / `bindByIds()` with chords from `KobeKeymap`.
4. Write focused unit tests for pure row/state/keymap logic. If the pane
   needs visible terminal validation, use the local PTY harness described in
   `docs/HARNESS.md`.

### A new engine activity hook

1. Add vendor-specific parsing in `src/engine/<vendor>-local/hook-adapter.ts`.
   The Adapter translates raw hook input into the shared
   `EngineActivityKind` / detail shape from `src/engine/hook-events.ts`.
2. Extend `reduceActivity` only when the shared task-activity state machine
   needs a new state. Keep vendor-only fields out of the daemon protocol.
3. Report the normalized event through `engine.reportEvent`; the daemon
   maps `cwd` to a Task, folds the event into `engine-state`, and replays
   current non-idle states to late subscribers.
4. Add a focused daemon socket test under `test/daemon/` and, if a visible
   badge changes, a sidebar row-view-model unit test under `test/tui/`.

### A new visible-flow check

Use `docs/HARNESS.md` for local PTY checks when a change affects what the
user sees or how keys route through the terminal. Keep the loop bounded:
capture a failing screen, fix the narrow cause, then rerun once or twice.

### A new orchestrator method

1. Add the method to `Orchestrator` in `src/orchestrator/core.ts`. Follow
   the existing shape: `requireTask(id)` to fetch + throw,
   `IllegalTransitionError` for state-machine violations, `await`
   `store.update(...)` so the listener bus refreshes the Solid signal
   automatically; don't call any explicit refresh hook from UI code.
2. Add a unit test under `test/orchestrator/` or a daemon RPC/socket test if
   the method is exposed over the daemon.
3. If the method is user-facing, surface it through `RemoteOrchestrator` /
   daemon RPC and the relevant pane handler, then run a visible-flow check
   when key routing or terminal output changes.
4. Engine Adapters do not know about new orchestrator methods. If a method
   needs engine-specific data, extend the Adapter-owned history/hook/usage
   surface instead of threading vendor checks through the UI.

---

## Pointers

- Run dev: `bun run dev` (preloads `@opentui/solid/preload`).
- Run unit + type tests: `bun run test`.
- Run behavior tests: `bun run test:behavior`.
- Lint: `bun run lint` (biome).
- Smoke: `timeout 5 bun run dev > /tmp/smoke.log 2>&1`.
- Phase status, gates G0–G4, shipped-as-`@sma1lboy/kobe@0.1.0`: see
  `CLAUDE.md` and `CHANGELOG.md`.
