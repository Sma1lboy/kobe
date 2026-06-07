# kobe — Architecture

> Map, not territory. If you've never seen the codebase, read this in 10 minutes
> and you should know "where does X live, and why is it there." For the *why* of
> the design choices, read [`DESIGN.md`](./DESIGN.md). For the *how it got built*,
> read [`PLAN.md`](./PLAN.md). For the *self-test contract*, read
> [`HARNESS.md`](./HARNESS.md). This document is a tour of the source tree as it
> currently stands.

> **Path convention.** kobe is the main package in a Bun-workspaces
> monorepo; its source lives at `packages/kobe/`. **Every `src/...`,
> `test/...`, and `scripts/...` path in this doc is relative to that
> package root.** The other workspace, `packages/branding/`, is the
> Remotion render pipeline for the brand artwork in `docs/assets/brand/`
> and isn't covered here.

## Contents

1. [The layer cake](#1-the-layer-cake)
2. [Reference projects under `refs/`](#2-reference-projects-under-refs)
3. [The 5-pane layout](#3-the-5-pane-layout)
4. [Engine ↔ orchestrator seam](#4-engine--orchestrator-seam)
5. [The behavior-test harness](#5-the-behavior-test-harness)
6. [Persistence: where state lives on disk](#6-persistence-where-state-lives-on-disk)
7. [What's deliberately NOT in kobe](#7-whats-deliberately-not-in-kobe)
8. [Recipes — how to add X](#8-recipes--how-to-add-x)

---

## 1. The layer cake

Four layers, top→bottom. Higher layers depend on lower; lower layers know
nothing about higher.

```
┌────────────────────────────────────────────────────────────────┐
│  TUI shell + panes  (Solid + @opentui/solid + @opentui/core)   │
│   src/tui/{app.tsx, index.tsx, panes/, context/, ui/, lib/}    │
├────────────────────────────────────────────────────────────────┤
│  Orchestrator  (the only thing that touches engine + git +     │
│   index together)                                              │
│   src/orchestrator/{core.ts, worktree/, index/, pr/}           │
├────────────────────────────────────────────────────────────────┤
│  AI engine port  (single seam)                                 │
│   src/types/engine.ts  (interface only)                        │
│   src/engine/claude-code-local/  (Phase-1 impl)                │
├────────────────────────────────────────────────────────────────┤
│  Types  (shared contracts)                                     │
│   src/types/{engine.ts, task.ts, worktree.ts, index.ts}        │
└────────────────────────────────────────────────────────────────┘
```

The seams matter:

- **Orchestrator never reaches past the engine port.** No PIDs, no
  subprocess refs, no raw stream-json shapes leak upward. See
  `src/types/engine.ts:8` for the rationale comment. If you find a
  `process.kill()` or a `spawn()` outside `src/engine/`, that's a leak.
- **Panes never reach past the orchestrator.** Chat, sidebar, etc. consume
  `Orchestrator` (`src/tui/app.tsx:32`) and ask it for tasks, history,
  events. They don't import `engine` or `worktree` directly.
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
| AI engine interface | `src/types/engine.ts` (one file, source of truth) |
| Spawning the `claude` CLI | `src/engine/claude-code-local/spawn.ts` |
| Parsing stream-json | `src/engine/claude-code-local/stream.ts` |
| Reading historical JSONL | `src/engine/claude-code-local/history.ts` |
| Finding the `claude` binary | `src/engine/claude-code-local/binary.ts` |
| Task lifecycle | `src/orchestrator/core.ts` |
| Per-task chat tabs (multi-session) | `src/orchestrator/core.ts:913` (`createTab`) + `src/types/task.ts:63` (`ChatTab`) |
| Pending user-input detection + response prompts | `src/orchestrator/user-input.ts` |
| `git worktree` wrapper | `src/orchestrator/worktree/manager.ts` |
| Worktree path convention | `src/orchestrator/worktree/paths.ts:30` |
| Task index on disk | `src/orchestrator/index/store.ts` |
| ULID generator | `src/orchestrator/index/ulid.ts` |
| PR prompt rendering | `src/orchestrator/pr/build.ts` |
| Application shell + layout | `src/tui/app.tsx` |
| TUI bootstrap (banner / fallback) | `src/tui/index.tsx` |
| Pane focus | `src/tui/context/focus.tsx` |
| Global keybindings | `src/tui/context/keybindings.ts` |
| KV (per-user UI state) | `src/tui/context/kv.tsx` |
| Theme (palettes + active theme) | `src/tui/context/theme.tsx` + `src/tui/context/theme/*.json` |
| Behavior-test driver | `test/behavior/driver.ts` |
| Fake engine for tests | `test/behavior/fake-engine.ts` |
| Unit-test type assertions | `test/types/*.test-d.ts` |

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

- `src/engine/claude-code-local/index.ts:1-37` describes the full
  spawn → stream → JSONL pipeline lifted from opcode.
- `src/engine/claude-code-local/binary.ts` mirrors opcode's
  `claude_binary.rs` discovery order (PATH → NVM → Homebrew →
  `~/.claude/local`).
- `src/engine/claude-code-local/history.ts:10-22` documents the
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` path scheme,
  cross-referenced with opcode.
- `src/orchestrator/core.ts:1177` (`detectUserInputFromEngineEvent`)
  cross-references upstream `refs/claude-code/src/tools/...`.
- `src/types/engine.ts:135` (`ApprovePlanPayload`) cites
  `refs/claude-code/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`.
- The chat composer's noise-tag stripper at
  `src/tui/panes/chat/store.ts:55-78` uses Claude Code's wrapper-tag
  taxonomy verbatim.
- Session usage metrics in `src/session/usage-metrics.ts` mirror
  `refs/ccstatusline/src/utils/jsonl-metrics.ts` by deriving total speed
  from conversation timestamps rather than trusting a precomputed speed field.

When two refs disagree with kobe, **kobe wins** (we already chose). But
read the ref before deciding to deviate further.

---

## 3. The 5-pane layout

The Conductor screenshot grammar lives in `src/tui/app.tsx`. Layout is
flex-first per the CLAUDE.md hard rule — only the sidebar's width and the
horizontal splitter heights are stateful, and even those use `flexGrow={1}`
on the right rail to absorb the remainder.

### Top-level structure

```
┌────────────────────────────────────────────────────────────────────┐
│ TopBar — version, repo/branch, Create PR button, update chip       │
├──────────┬──────────────────────────────┬──────────────────────────┤
│ Sidebar  │ WORKSPACE                    │ FILES                    │
│  (1)     │  CenterTabStrip [chat][file] │  (3)                     │
│          │  ┌─────────────────────────┐ │                          │
│          │  │  Chat | Preview         │ ├──────────────────────────┤
│          │  │  (chat owns the slot    │ │ TERMINAL                 │
│          │  │   when chat tab active) │ │  (4)                     │
│          │  └─────────────────────────┘ │                          │
├──────────┴──────────────────────────────┴──────────────────────────┤
│ StatusBar — keybinding hints + active task                         │
└────────────────────────────────────────────────────────────────────┘
   ^pane 1               ^pane 2 (workspace)             ^panes 3+4
```

Wire-up (in `src/tui/app.tsx`, function `Shell`):

- Sidebar render: `src/tui/app.tsx:1561`
- Workspace tabs: `src/tui/app.tsx:1616`
- Chat ↔ Preview switch (chat tab vs file tab): `src/tui/app.tsx:1628`
- File tree render: `src/tui/app.tsx:1675`
- Terminal render: `src/tui/app.tsx:1699`
- Resizable splitters: `<ResizableEdge>` between each pair, see
  `src/tui/component/resizable-edge.tsx`.

### Pane sources

| Pane | Source dir | Notes |
|---|---|---|
| Sidebar | `src/tui/panes/sidebar/` | Working / Archives split, repo-grouped, `[d]` delete + `[a]` archive + `[r]` rename + `[n]` new (sidebar focus) |
| Chat | `src/tui/panes/chat/` | Multi-tab per task; `Composer.tsx` + `MessageList.tsx`; pure-data store at `store.ts` |
| File tree | `src/tui/panes/filetree/` | `git ls-files`-driven, three top tabs (All / Changes / Checks) |
| Preview | `src/tui/panes/preview/` | Multi-tab (one per opened file); File / Diff modes |
| Terminal | `src/tui/panes/terminal/` | Bun native PTY per task, rendered through `@xterm/headless`; pipe backend is fallback only |

### Focus + keymap routing

Focus is a single signal: `src/tui/context/focus.tsx`. `useFocus()` exposes
`focused()`, `setFocused(pane)`, `is(pane)`, `cycle(±1)`. The four pane ids
are `"sidebar" | "workspace" | "files" | "terminal"`.

Three rules govern key handling:

1. **Modifier-prefixed keys (`ctrl+1`..`ctrl+4`, `ctrl+n`, `ctrl+k`,
   `ctrl+q`) are always-on** — they never collide with composer typing.
   See `src/tui/context/keybindings.ts:170-201`.
2. **Single-letter global shortcuts (`?`, `q`, `tab`) are gated on
   "no input is focused"** — `useKobeKeybindings({ inputFocused })`
   reads the focus signal and omits these registrations whenever the
   workspace pane (which contains the chat composer) is focused.
3. **Pane-local bindings (`j/k` in sidebar, `enter`/`shift+enter` in
   composer) register inside the pane component** via
   `useBindings()` from `src/tui/lib/keymap.tsx`, scoped to that
   component's lifetime. The pane gates them on `useFocus().is(...)`.

The keybinding registry itself is a stack — dialogs push their own group on
top so `escape` / `enter` apply to the dialog while it's open, not the
underlying pane. See `src/tui/ui/dialog.tsx` for the dialog stack.

---

## 4. Engine ↔ orchestrator seam

The single most-load-bearing contract in kobe. Read `src/types/engine.ts`
top to bottom — the comments are the spec.

### The interface (`AIEngine`)

```ts
interface AIEngine {
  spawn(cwd, prompt, opts?): Promise<SessionHandle>
  resume(sessionId, prompt, opts?): Promise<SessionHandle>
  stream(handle): AsyncIterable<EngineEvent>
  readHistory(sessionId): Promise<Message[]>
  deleteHistory(sessionId): Promise<void>
  stop(handle): Promise<void>
}
```

`SessionHandle` is opaque to the orchestrator except for `sessionId` (the
Claude Code session UUID). `EngineEvent` is a discriminated union — six
cases: `assistant.delta`, `tool.start`, `tool.result`, `usage`, `done`,
`error`. Defined at `src/types/engine.ts:91`.

### How `claude --output-format stream-json` becomes `ChatRow`s

Path the bytes take, end to end:

```
claude (subprocess)                        emits stream-json on stdout
  └─> spawn.ts (child_process.spawn)       exposes the stdout stream
        └─> stream.ts:readLines+parseStreamJson
                                           normalises JSONL → EngineEvent
              └─> ClaudeCodeLocal.start    pumps eagerly into a queue
                    └─> stream(handle)     yields lazily to consumers
                          └─> Orchestrator.pumpEvents
                                           dispatches to per-(task,tab) bus
                                └─> Chat (chat/store.ts:applyEvent)
                                           grows messages[] in place
                                      └─> MessageList.tsx
                                           renders ChatRows as JSX
```

Key points:

- The eager-pump pattern in `ClaudeCodeLocal.start` (see comment block
  at `src/engine/claude-code-local/index.ts:31-37`) is intentional: the
  spawn promise must resolve when `system.init` arrives, but the consumer
  hasn't called `stream()` yet, so we drive the parser ourselves and queue.
- `SessionRegistry` (`src/engine/claude-code-local/registry.ts`) is
  in-memory only. On a `done` or `error` it `unregister()`s the session
  so the next `resume(sid,...)` doesn't blow up with `duplicate sessionId`
  — this was a real bug, see `src/engine/claude-code-local/index.ts:223-229`.
- Resume needs the original `cwd`. The orchestrator passes it via
  `opts.env.KOBE_RESUME_CWD` — load-bearing back-channel documented at
  `src/orchestrator/core.ts:24-29` and consumed at
  `src/engine/claude-code-local/index.ts:93`.

### `pumpEvents` — orchestrator-side stream consumer

`Orchestrator.pumpEvents` lives at `src/orchestrator/core.ts:1083`. One
pump per (task, tab) pair. Responsibilities:

1. `for await (const ev of engine.stream(handle))` — drain events.
2. On every event, `dispatchEvent(taskId, tabId, ev)` — fan out to chat
   subscribers (`src/orchestrator/core.ts:1068`).
3. **Detect user-input pause tools** via
   `detectUserInputFromEngineEvent` (`src/orchestrator/core.ts:1177`):
   when `ExitPlanMode` or `AskUserQuestion` arrives as a `tool.start`,
   the pump emits a synthetic `user_input.request` event AND kills
   the subprocess (because `claude -p` doesn't actually wait for user
   input — it returns a default and keeps yapping). The user's response
   flows back through `respondToInput()` which `--resume`s the session
   with a synthesized prompt.
4. On terminal `done` / `error`, flip the task's status — but only when
   *all* sibling tabs have stopped (multi-tab caveat at
   `src/orchestrator/core.ts:1132-1148`).
5. `finally` always cleans the handle map and the pump map so leaks
   don't accumulate.

### Orchestrator-only event types

Engines never emit these — the orchestrator synthesizes them onto the
same per-(task, tab) bus the chat consumes:

| Event | Source | Purpose |
|---|---|---|
| `user.inject` | `requestPR`, `respondToInput` | Show an orchestrator-injected prompt as a normal user row |
| `user_input.request` | `pumpEvents` after detecting `ExitPlanMode` / `AskUserQuestion` | Render an Approve/Reject or multi-choice picker |
| `user_input.resolved` | `respondToInput` | Flip the picker row to its final state |
| `system.info` | `runTask` lazy worktree alloc, `maybeRenameTempBranch` | Dim system rows for lifecycle moments |

Type union: `OrchestratorEvent` at `src/types/engine.ts:263`.

---

## 5. The behavior-test harness

> Tests aren't just typecheck + unit. The agent runs the actual product
> and asserts visible behavior. See [`HARNESS.md`](./HARNESS.md).

Three test tiers, three locations:

| Tier | Lives in | What it proves | Cost |
|---|---|---|---|
| Type-level | `test/types/*.test-d.ts` | The interface shape compiles correctly | ms (tsc) |
| Unit | `test/{engine,orchestrator,tui}/*.test.ts(x)` | Pure logic correct (parsers, stores, reducers) | ~10ms each |
| Behavior | `test/behavior/*.test.ts` | The product, run end-to-end under PTY, behaves correctly | ~30s each |

### How a behavior test runs

`test/behavior/driver.ts:137` (`spawnKobe`) launches `bun --preload @opentui/solid/preload src/cli/index.ts` inside a `node-pty` shell with `TERM=xterm-256color`, returns a handle:

```ts
sendKeys(seq) / typeText(s)   // write bytes to stdin
capture()                      // ANSI-stripped plain-text snapshot
captureRaw()                   // raw bytes, ANSI intact
waitFor(predicate, timeoutMs)  // poll capture until pred or timeout
exit()                         // SIGTERM → 750ms grace → SIGKILL
```

ANSI normalization is in `test/behavior/screen.ts`. Read it before
asserting on screen text — it strips cursor codes, normalizes whitespace,
collapses repeated blanks.

### The fake engine — why it exists

Real `claude` calls cost tokens, hit the network, are non-deterministic.
For behavior tests we substitute `FakeAIEngine` (`test/behavior/fake-engine.ts`):

- Pure in-memory `AIEngine` impl.
- `script(sessionId, events[])` queues engine events.
- `finish(sessionId)` closes the stream cleanly.
- Sessions are deterministic: `fake-1`, `fake-2`, ...

### The HTTP side-channel

The behavior test runs in vitest under Node; kobe runs in a child Bun
process under PTY. They can't share a `FakeAIEngine` instance via memory
— so `src/tui/app.tsx:85` (`mountFakeEngineServer`) opens a tiny `http`
server on `127.0.0.1:KOBE_TEST_FAKE_PORT` exposing four endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /script` | Push scripted events to a session |
| `POST /finish` | Close a session's stream |
| `POST /pr` | Trigger `requestPR` on the active task |
| `POST /respond` | Resolve a pending `user_input.request` |

`/pr` and `/respond` reach into the running app via two globals
(`__kobeTestRequestPR`, `__kobeTestRespondToInput`) that the Shell
mounts after the orchestrator is alive. The `/respond` path uses
`Orchestrator.peekPendingInput()` (`src/orchestrator/core.ts:306`) to
discover the latest requestId without faking SGR mouse events. This is
the test seam called out in CHANGELOG `[0.1.1]`.

### When to use which tier

- Pure logic? Unit test in `test/{engine,orchestrator,tui}/`. Fast, easy
  to diagnose.
- "Does the chat render this event correctly?" Unit test against
  `chat/store.ts` + `MessageList.tsx`.
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
| `~/.kobe/tasks.json` | `TaskIndexStore` (`src/orchestrator/index/store.ts`) | The task manifest — id, title, repo, branch, worktreePath, tabs, activeTabId, status, archived flag, permissionMode, model |
| `~/.kobe/tasks.json.tmp` | `TaskIndexStore` (atomic write) | Transient — written then renamed over `tasks.json` |
| `~/.kobe/<lockfile>` | `src/orchestrator/index/lockfile.ts` | Multi-process safety for the manifest |
| `~/.config/kobe/state.json` | `src/tui/context/kv.tsx` (`KVProvider`) | Per-user UI state — selected theme, transparent-bg toggle, pane sizes, last-open task, expanded sidebar groups |
| `~/.claude/projects/<encoded-cwd>/<sessionUUID>.jsonl` | Claude Code itself; we *read* via `engine.readHistory()` and *delete* via `engine.deleteHistory()` | Full message history per session. kobe never writes here. |
| `~/.kobe/worktrees/<repo-key>/<slug>/` | `GitWorktreeManager` (`src/orchestrator/worktree/manager.ts`) | Per-task git worktree for new kobe-created tasks. Convention defined at `src/orchestrator/worktree/paths.ts:30`; repo-local `<repo>/.kobe/worktrees/<slug>/` and legacy `<repo>/.claude/worktrees/<slug>/` paths remain recognized for existing tasks. |
| `<worktreePath>/.kobe/pr-instructions.md` | Read by `src/orchestrator/pr/instructions.ts` | Optional per-repo override for the PR-creation prompt |

What's deliberately NOT persisted:

- Chat messages (Claude Code's JSONL is the source of truth).
- Engine handles / PIDs (in-memory only — see
  `src/engine/claude-code-local/registry.ts`).
- Pending user-input requests (in-memory map at
  `src/orchestrator/core.ts:230`; lost on restart, by design).
- Pending worktree opts after `createTask` but before first `runTask`
  (`src/orchestrator/core.ts:240` — process-scoped, fine because the
  new-task flow always submits immediately).

Backwards compat: `Task.sessionId` (deprecated) is a read-only alias for
`tabs[0].sessionId` so v1 manifests still load.
`TaskIndex.version: 2` is the current shape — see `src/types/task.ts:138`.

---

## 7. What's deliberately NOT in kobe

DESIGN.md §12 is the authoritative list. Highlights:

| Not in kobe | Where it'd live if we did it | Why we don't |
|---|---|---|
| Conductor-as-backend (was "Phase 2") | A `ConductorBackend implements AIEngine` next to `ClaudeCodeLocal/` | Dropped 2026-05-09 — no real product driver. The `AIEngine` seam stays in place if a concrete swap need ever surfaces. |
| Vendor-neutral model abstraction (`@ai-sdk/*` etc) | n/a | Engine port is at the *Claude Code session* level, not the *LLM call* level. We are opinionated about the engine. |
| Cloud sync, multi-machine state | n/a | Local-first. Single developer per machine. |
| Team collaboration | n/a | Single-developer-focused. |
| Plugin system for panes | n/a | Every pane is hardcoded. Pluggability is at the engine layer only. |
| Web/mobile UI | n/a | Terminal is a feature (DESIGN.md §2.3), not a constraint we want to escape. |
| Auto-update mechanism | TopBar shows a chip when a newer version is on npm — see `src/version.ts` — but kobe does not self-install. The chip links to the install command. | Auto-install was deferred from Wave 4. |
| Status state machine in the sidebar UI | The state machine still exists on disk (`Task.status: backlog | in_progress | in_review | done | canceled | error`) — it drives the concurrency cap and is wired through. The sidebar groups by Working / Archives instead of by status. | Conductor-style status grouping was simplified. The 5 status states are kept on disk so the experimental flag can re-introduce the UI later. |

If you find yourself reaching for any of the above, stop and ask first.

---

## 8. Recipes — how to add X

### A new pane

1. Create `src/tui/panes/<name>/` with at least an `index.ts` and a
   component file. Mirror the shape of an existing pane (`filetree/`
   is small and self-contained).
2. Add the pane id to `PaneId` in `src/tui/context/focus.tsx:37` and
   to `PANE_ORDER` if you want it in the tab cycle.
3. Mount the component inside `Shell` in `src/tui/app.tsx`. Wrap it in
   a `<box onMouseUp={() => setFocusedPane(...)}>` so click-to-focus
   works. Add a `<PaneHeader>` so it gets the BOLD CAPS label
   convention.
4. Pane-local keybindings register inside the pane component via
   `useBindings()`, gated on `useFocus().is("<name>")()`.
5. Write at least one behavior test under `test/behavior/<name>.test.ts`.
   If the pane needs scope isolation (file tree, preview, terminal
   already do this), add a host-mode env var branch in
   `src/cli/index.ts:33` and a fixture under
   `test/behavior/fixtures/<name>-host.tsx`.

### A new tool-result renderer

1. The `ChatRow` union is in `src/tui/panes/chat/store.ts:81`. Tool rows
   are already supported — most new tools just need a render branch.
2. Render branches live in `src/tui/panes/chat/MessageList.tsx`. Find
   the tool-row switch and add a case keyed on `name`.
3. If the tool *pauses for user input* (like `ExitPlanMode` and
   `AskUserQuestion`), the path is bigger:
   - Extend `UserInputPayload` in `src/types/engine.ts:185`.
   - Add a detector branch in `detectUserInputFromEngineEvent`
     (`src/orchestrator/core.ts:1177`).
   - Add a synthetic-prompt builder in `renderUserInputResponsePrompt`
     (`src/orchestrator/core.ts:1243`).
   - Render the picker in `MessageList.tsx`; wire its callback to
     `orchestrator.respondToInput(taskId, requestId, response)`.
4. Mirror the upstream tool's schema from `refs/claude-code/src/tools/`
   so kobe stays render-compatible.

### A new behavior test

Already covered by `test/behavior/README.md` — read it. The 30-second
version: copy `test/behavior/example.test.ts`, replace the assertions,
remember to `await kobe.exit()` in `afterEach`, set `KOBE_TEST_ENGINE=fake`
and a unique `KOBE_TEST_FAKE_PORT` if you need to script engine output.
The MEMORY entry "Don't spin in test loops while debugging" applies —
each behavior test costs ~30s; cap at ~2 runs per debug cycle.

### A new orchestrator method

1. Add the method to `Orchestrator` in `src/orchestrator/core.ts`. Follow
   the existing shape: `requireTask(id)` to fetch + throw,
   `IllegalTransitionError` for state-machine violations, `await`
   `store.update(...)` so the listener bus refreshes the Solid signal
   automatically (don't call any explicit `refreshSignal()` — see the
   class-level comment at `src/orchestrator/core.ts:42-49`).
2. Add a unit test in `test/orchestrator/core.test.ts` against
   `FakeAIEngine` (`test/behavior/fake-engine.ts` is reusable — but
   import the test-only `_engine-types.ts` mirror).
3. If the method is user-facing, surface it through the chat or
   sidebar handlers in `src/tui/app.tsx` and add a behavior test.
4. Engines never know about new orchestrator methods — keep the engine
   port minimal. If a new method needs new engine capability, that's an
   `AIEngine` interface change too, and `ClaudeCodeLocal` plus
   `FakeAIEngine` must both update.

---

## Pointers

- Run dev: `bun run dev` (preloads `@opentui/solid/preload`).
- Run unit + type tests: `bun run test`.
- Run behavior tests: `bun run test:behavior`.
- Lint: `bun run lint` (biome).
- Smoke: `timeout 5 bun run dev > /tmp/smoke.log 2>&1`.
- Phase status, gates G0–G4, shipped-as-`@sma1lboy/kobe@0.1.0`: see
  `CLAUDE.md` and `CHANGELOG.md`.
