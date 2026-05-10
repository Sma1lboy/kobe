# kobe — Phase 0 → Phase 1 Plan

> Read [`DESIGN.md`](./DESIGN.md) first. This document operationalizes it: what to build, in what order, by whom, with what dependencies.
>
> **Stack** (locked): TypeScript + `@opentui/core` + `@opentui/solid` + Solid.js + Bun.
>
> Plan model: **streams** that run in parallel, converging at named **integration points** where everything must land for a demoable milestone. Each stream is sized for one Claude Code agent in one focused session (~600–1500 LoC).

---

## How to read this doc

- Each **wave** is a parallel batch — agents in the same wave run concurrently, no dependency between them.
- **Integration points** (▶) are gates. Nothing in the next wave starts until the gate is green.
- Each stream has: **Scope**, **Inputs** (deps), **Outputs** (artifacts), **Done when** (acceptance), **Suggested agent prompt seed**.
- Total wall-clock estimate assumes 1 human reviewer + N parallel agents. Sequential lower bound is roughly the longest path.

---

## Dependency graph (the critical path)

```
Phase 0
  └─ 0.1 Repo bootstrap ──┬─ 0.2 Lift opencode shell ─┐
                          ├─ 0.3 Core types ──────────┤
                          └─ 0.4 Behavior harness ────┤
                                                      ▼
                                          [▶ Gate G0: shell renders +
                                                test:behavior runs]

Phase 1 — Wave 1 (parallel)
  ┌─ A. ClaudeCodeLocal engine
  ├─ B. Worktree manager
  ├─ C. Task index
  └─ D. Theme + keybindings ringbuffer
                ▼
         [▶ Gate G1: orchestrator can run a task]

Phase 1 — Wave 2 (parallel)
  ┌─ E. Orchestrator core (glue A+B+C)
  └─ F. Sidebar pane (consumes C)
                ▼
         [▶ Gate G2: single-task chat demo]
                                                      ┐
Phase 1 — Wave 3 (parallel, after G2)                 │
  ┌─ G. Chat pane                                      │
  ├─ H. File tree pane                                 │
  ├─ I. Diff/preview pane                              │
  └─ J. Terminal pane                                  │
                ▼                                      │
         [▶ Gate G3: full 5-pane demo]                 │
                                                      │
Phase 1 — Wave 4 (sequential polish)
  ├─ K. Status flow + checks pane
  ├─ L. PR button + cmd-k task switcher
  └─ M. Multi-task end-to-end QA
                ▼
         [▶ Gate G4: Phase 1 ship]
```

---

## Phase 0 — Foundation

Three streams. 0.2 and 0.3 can run parallel after 0.1 commits.

### Stream 0.1 — Repo bootstrap

**Scope**: Make the repo runnable. Set up package layout, tooling, scripts.

**Inputs**: HANDOFF.md, DESIGN.md, opencode's `package.json` and `tsconfig.json` as templates.

**Outputs**:
- `package.json` (Bun workspace), `tsconfig.json`, `biome.json` (or `eslint`/`prettier` matching opencode)
- `vitest.config.ts` for unit tests
- Directory structure:
  ```
  src/
    cli/           # entry point (Commander or Bun's argv)
    tui/           # opentui + Solid components (lifted from opencode)
    engine/        # AI engine port + impls
    orchestrator/  # task lifecycle, worktree, index
    types/         # shared types
  test/
  docs/
  ```
- `bun run dev` starts the TUI (even if it's just an empty box — proves the build pipeline)
- `.gitignore` updated; `refs/` already covered

**Done when**: `bun install && bun run dev` opens a blank opentui window without errors.

**Agent prompt seed**:
> Bootstrap the kobe repo at `/Users/jacksonc/i/kobe`. Use opencode (`refs/opencode/packages/opencode/package.json` and `tsconfig.json`) as a template. Create the directory structure listed in PLAN.md §0.1. Add minimal Bun-runnable entry that opens an empty opentui screen with title "kobe". Set up vitest. Don't add features; just prove the pipeline works.

---

### Stream 0.2 — Lift opencode TUI shell

**Scope**: Copy the relevant parts of `refs/opencode/packages/opencode/src/cli/cmd/tui/` into our `src/tui/`, strip everything we don't need.

**Inputs**: Stream 0.1 done; explore agent's report on opencode in HANDOFF context (what's reusable).

**Outputs**:
- `src/tui/ui/dialog.tsx` (dialog stack)
- `src/tui/ui/dialog-confirm.tsx`, `dialog-alert.tsx`
- `src/tui/component/border.tsx`, `dialog-diff.tsx` (rename later if ergonomic)
- `src/tui/context/theme.tsx` + `theme/*.json` (all themes copied)
- `src/tui/context/sync.tsx`, `kv.tsx`, `command-palette.tsx`
- Stripped: vendor/auth/route code, opencode-specific commands (`appCommands` cleared to `[]`), API client calls (every `sdk.client.*` removed or stubbed)

**Done when**: `bun run dev` shows an opentui window with theme applied; `cmd-k` opens an empty command palette dialog (proves dialog system works).

**Suggested agent prompt seed**:
> Lift opencode's TUI shell into kobe. Source: `refs/opencode/packages/opencode/src/cli/cmd/tui/`. Target: `src/tui/`. Copy the modules listed in DESIGN.md §7.1 (dialog system, theme, sync store, command palette, scrollbox primitives). Strip vendor/auth/route/SDK code — anything calling `sdk.client.*` should be removed or stubbed with TODO. Goal: opencode shell renders in our repo with no opencode-specific business logic. Don't add new features.

---

### Stream 0.3 — Core types

**Scope**: Define the interfaces that downstream streams will satisfy. This is the contract.

**Inputs**: DESIGN.md §5.2 (AIEngine), §10 (Task data model). Run in parallel with 0.2.

**Outputs**: `src/types/`:
- `engine.ts` — `AIEngine` interface, `SessionHandle`, `EngineEvent`, `SpawnOpts`, `Message`
- `task.ts` — `Task`, `TaskStatus`, `TaskIndex`
- `worktree.ts` — `WorktreeInfo`, `WorktreeManager` interface
- Exhaustive type unions (use discriminated unions for events).
- One unit test per type asserting basic shape via tsc.

**Done when**: `bun run typecheck` is green; downstream streams can `import { AIEngine } from "src/types"` and start coding against it.

**Suggested agent prompt seed**:
> Define kobe's core type contracts in `src/types/`. Sources: DESIGN.md §5.2 (AIEngine port), §10 (Task data model). Also read `refs/vibe-kanban/crates/executors/` for interface shape lessons. Output: `engine.ts`, `task.ts`, `worktree.ts`. Use discriminated unions for events. No implementations — types only. Add type-only test files asserting shape via `expectTypeOf`.

---

### Stream 0.4 — Behavior test harness (Foundation Team)

**Scope**: Build the infrastructure that lets every subsequent stream self-test by *running the product*. This is the load-bearing piece for the agent-self-validates property of HARNESS.md.

**Inputs**: Stream 0.1 (entry point exists). Runs in parallel with 0.2 and 0.3.

**Outputs**: `test/behavior/`:
- `driver.ts` — exports `spawnKobe(opts)` returning a `KobeHandle`. Built on `node-pty` (or Bun's PTY equivalent if mature). Key methods: `sendKeys(seq)`, `typeText(s)`, `capture()` (returns visible screen as string), `waitFor(predicate, timeoutMs)`, `exit()`. Tmux backend optional fallback if PTY proves flaky on macOS.
- `screen.ts` — ANSI-aware screen buffer parser. Strip cursor codes, normalize whitespace, return plain text. Make assertions readable (no ANSI noise in `toContain` failures).
- `fake-engine.ts` — `FakeAIEngine implements AIEngine`. Scripted event sequences via `FakeAIEngine.script(sessionId, events[])`. Deterministic. **Note**: needs Stream 0.3's types — coordinate with 0.3 agent (read its commit before finishing).
- `fixtures/` — `repo-init.sh` builds a tiny test git repo; sample `tasks.json`; preset behavior scripts.
- `example.test.ts` — one passing behavior test: spawn kobe, capture, assert "kobe — booting" visible. Proves the harness works.
- `README.md` — author guide for behavior tests (50–100 lines).
- Add `bun run test:behavior` script to `package.json`.

**Done when**:
- `bun run test:behavior` passes the example test on a clean checkout.
- `bun run test:behavior --watch` works for iteration.
- Driver supports at least: `sendKeys`, `typeText`, `capture`, `exit`, with timeouts.
- README has copy-paste recipe for "write a behavior test in 5 minutes."

**Agent prompt seed**:
> You are Stream 0.4 of the kobe Foundation Team. Read `/Users/jacksonc/i/kobe/CLAUDE.md`, `docs/DESIGN.md`, `docs/PLAN.md` (your stream + dep graph), and `docs/HARNESS.md` (especially the "Behavioral self-test" section — that's the contract you're building infrastructure for).
>
> Your sibling agents on this team:
> - Stream 0.2 is lifting the opencode TUI shell into `src/tui/`.
> - Stream 0.3 is defining `src/types/engine.ts`, `task.ts`, `worktree.ts`. Your `FakeAIEngine` depends on its `AIEngine` interface — read `src/types/engine.ts` after 0.3 commits, before you finalize `fake-engine.ts`. If 0.3 isn't done when you need it, surface and pause; don't redefine the interface yourself.
>
> Build the deliverables in PLAN.md §0.4. Use `node-pty` (or Bun PTY if available) as primary backend. The driver must be **thin** — your job is to make behavior tests easy to write, not to ship a TUI testing framework. ~400–600 LoC total.
>
> Self-validate per HARNESS.md: typecheck, lint, unit-test the driver itself (mock pty), and your example.test.ts must pass. Commit on green.

---

### ▶ Gate G0 — "Shell renders + behavior harness lives"

Self-check (the orchestrator runs these, no human needed):
- [ ] `bun install` clean
- [ ] `bun run dev` opens kobe with theme (Stream 0.2)
- [ ] `bun run typecheck` green
- [ ] `bun run test` green (Stream 0.3 type tests at minimum)
- [ ] `bun run test:behavior` green (Stream 0.4 example test)
- [ ] All four Phase 0 streams committed and merged to main

---

## Phase 1 — Wave 1 (4 streams in parallel)

After G0. All four can ship without seeing each other.

### Stream A — `ClaudeCodeLocal` engine impl

**Scope**: Implement the `AIEngine` interface for local `claude` CLI.

**Inputs**: Stream 0.3 (`AIEngine` interface). Reference: `refs/opcode/src-tauri/src/commands/claude.rs` lines 147–230, 919–1014, 1173–1327; `refs/opcode/src-tauri/src/claude_binary.rs`.

**Outputs**: `src/engine/claude-code-local/`:
- `binary.ts` — find `claude` on PATH/NVM/Homebrew/`~/.claude/local`
- `spawn.ts` — child_process spawn with stream-json flags
- `stream.ts` — line-by-line JSONL parser → typed `EngineEvent` AsyncIterable
- `history.ts` — read `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, return `Message[]`
- `index.ts` — class `ClaudeCodeLocal implements AIEngine`
- Tests: spawn a `claude` process with `--help` and assert exit; mock JSONL lines and assert event normalization.

**Done when**:
- `new ClaudeCodeLocal().spawn(cwd, "say hi", {})` returns a handle that streams events ending in `{ type: "done" }`.
- `readHistory(uuid)` returns parsed messages.
- Unit tests pass.

**Agent prompt seed**:
> Implement `ClaudeCodeLocal` satisfying the `AIEngine` interface in `src/types/engine.ts`. Port the algorithm from `refs/opcode/src-tauri/src/commands/claude.rs` — Rust → TS. File layout per PLAN.md §A. Use Node `child_process.spawn` and `readline.createInterface` over stdout. Normalize stream-json events to our `EngineEvent` discriminated union (do not leak Claude Code's raw shape upward). Tests: mock stream-json input, assert event sequence; integration test that spawns real `claude --help`. ~400 LoC target.

---

### Stream B — Worktree manager

**Scope**: Wrap `git worktree add/remove/list` and dirty-state detection.

**Inputs**: Stream 0.3 (`WorktreeManager` interface). Reference: `refs/vibe-kanban/crates/worktree-manager/` (read for invariants, port nothing).

**Outputs**: `src/orchestrator/worktree/`:
- `manager.ts` — `class GitWorktreeManager implements WorktreeManager`
- Methods: `create(repo, branch, path)`, `remove(path, { force })`, `list(repo)`, `isDirty(path)`, `currentBranch(path)`
- Use `bun.spawn` or Node `execFile` for git calls; never shell-string-concatenate.
- Per task convention from DESIGN.md §11.3 (resolved: `<repo>/.claude/worktrees/<task-id>/`, shared with Claude Code's own agent-spawn root)
- Tests: in `test/fixtures/`, init a tiny repo, create + remove worktrees, assert state.

**Done when**: All methods green in unit tests; round-trip create→remove leaves no orphan files or branches.

**Agent prompt seed**:
> Implement `GitWorktreeManager` per `src/types/worktree.ts`. Use `git worktree` subcommands via `bun.spawn` (no shell concat — pass args as array). Per DESIGN.md §11.3, default worktree root is `<repo>/.claude/worktrees/<task-id>/` (shared namespace with Claude Code's own agent-spawn worktrees). Read `refs/vibe-kanban/crates/worktree-manager/` for invariants on cleanup and dirty-state detection. Tests must use a real fixture repo (`test/fixtures/repo-init.sh`); no mocking git. ~300 LoC.

---

### Stream C — Task index

**Scope**: Persist the task list at `~/.kobe/tasks.json`.

**Inputs**: Stream 0.3 (`Task`, `TaskIndex`).

**Outputs**: `src/orchestrator/index/`:
- `store.ts` — `class TaskIndexStore`, methods: `load()`, `save()`, `get(id)`, `list()`, `create(partial)`, `update(id, patch)`, `archive(id)`
- Atomic writes (write to `tasks.json.tmp`, rename)
- File lock (`proper-lockfile` or simple PID file) to prevent multi-process corruption
- Migration field (`version: 1`) for future shape changes
- Tests: CRUD round-trips; concurrent-write rejection; corrupted file recovery (load with bad JSON returns empty index, doesn't crash)

**Done when**: All CRUD ops covered by unit tests; concurrent-write test shows lock works.

**Agent prompt seed**:
> Implement `TaskIndexStore` for `~/.kobe/tasks.json` per `src/types/task.ts` and DESIGN.md §10. Atomic writes via tmp+rename. Use a lockfile to prevent corruption from a future second kobe instance. Include `version: 1` field. On corrupted JSON, log and start fresh (don't crash). Tests: `~200 LoC` of CRUD + concurrency tests. ~250 LoC impl.

---

### Stream D — Theme + keybindings + dialog wiring

**Scope**: Make the lifted opencode shell *ours* — pick default theme, register kobe keybindings.

**Inputs**: Stream 0.2 (shell lifted).

**Outputs**:
- `src/tui/context/theme.tsx` — default theme set to one we like (proposal: `nord` or `aura` from opencode's set; user picks)
- `src/tui/context/keybindings.ts` — central keymap table (vi-style, configurable later). Bindings for: focus next/prev pane, open task list, command palette, quit, esc-cancel.
- `src/tui/component/help-dialog.tsx` — `F1` key shows current bindings
- Tests: snapshot test on theme JSON shape; smoke test that `F1` opens help.

**Done when**: kobe boots into themed UI with help dialog accessible.

**Agent prompt seed**:
> Wire kobe's theme + keybindings on top of the lifted opencode shell. Pick `nord` as default (changeable via `~/.kobe/config.json` later — for now hardcode). Define keymap in `src/tui/context/keybindings.ts` per PLAN.md §D. Implement `F1` help dialog showing current bindings. ~150 LoC.

---

### ▶ Gate G1 — "Orchestrator can run a task"

Manual check:
- [ ] `ClaudeCodeLocal.spawn()` works against real `claude` CLI
- [ ] `GitWorktreeManager.create()` creates a worktree
- [ ] `TaskIndexStore.create()` persists a task
- [ ] kobe boots themed with `F1` help

These four are the building blocks. Wave 2 glues them.

---

## Phase 1 — Wave 2 (2 streams in parallel)

### Stream E — Orchestrator core

**Scope**: The glue. Owns task lifecycle, dispatches to Wave-1 modules.

**Inputs**: Streams A, B, C.

**Outputs**: `src/orchestrator/core.ts`:
- `class Orchestrator` with methods: `createTask({ repo, title, prompt })`, `runTask(id)`, `pauseTask(id)`, `archiveTask(id)`, `getTask(id)`, `subscribeEvents(id, cb)`
- Internally: ulid → Task; on `runTask`, call `WorktreeManager.create()`, then `Engine.spawn(worktreePath, prompt)`, plumb events into a per-task event bus, update `TaskIndex.status`.
- Event bus: simple per-task EventEmitter; UI subscribes.
- Tests: integration test creating + running + archiving a task end-to-end with a mock engine.

**Done when**: `Orchestrator.runTask(id)` end-to-end works with `ClaudeCodeLocal` and a real worktree; events stream to a subscriber.

**Agent prompt seed**:
> Implement the `Orchestrator` class in `src/orchestrator/core.ts`. It composes `ClaudeCodeLocal` (Stream A), `GitWorktreeManager` (Stream B), `TaskIndexStore` (Stream C). API per PLAN.md §E. Per-task event bus via Node EventEmitter. Status transitions: `backlog → in_progress` on runTask, `→ done` on engine `done` event, `→ error` on engine `error`. Integration test with a mock engine showing the full lifecycle. ~400 LoC.

---

### Stream F — Sidebar pane

**Scope**: The history pane. Render task list grouped by status, navigable.

**Inputs**: Stream C (TaskIndexStore — read-only here), Stream 0.2 (sidebar component reference from `refs/opencode/.../routes/session/sidebar.tsx`).

**Outputs**: `src/tui/panes/sidebar/`:
- `Sidebar.tsx` — Solid component, 42-char fixed width
- Status groups: Done / In review / In progress / Backlog / Canceled (collapsible)
- Cursor nav (j/k); enter selects task and emits `selectTask(id)` event
- Subscribe to `TaskIndexStore` updates (poll or push)
- Test: render with mock task list, assert grouping and cursor nav

**Done when**: Sidebar renders standalone in a test harness with sample data; cursor navigation works.

**Agent prompt seed**:
> Build the kobe sidebar pane. Adapt `refs/opencode/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`. 42-char fixed width. Group tasks by status (5 groups, collapsible). Cursor j/k nav. Read tasks from `TaskIndexStore` (Stream C), poll every 1s for changes (we'll move to push later). Emit `selectTask(id)` via Solid signal. Standalone test harness with 9 mock tasks. ~250 LoC.

---

### ▶ Gate G2 — "Single-task chat demo"

This is the **first demoable milestone**. Build a temporary `App.tsx` that wires Sidebar (F) + a placeholder chat area + Orchestrator (E). User can:
- Press `ctrl+n` to create a task (prompts for title + repo)
- See it in the sidebar
- Press enter to select it; chat area renders streamed events from `ClaudeCodeLocal`

This is **not** the final UI. It's an end-to-end wiring proof.

Manual check:
- [ ] Create a task via `ctrl+n`
- [ ] Worktree appears on disk
- [ ] Claude Code spawns, output streams into the placeholder chat
- [ ] Task transitions backlog → in_progress → done
- [ ] Sidebar reflects status changes

---

## Phase 1 — Wave 3 (4 streams in parallel)

After G2. The four panes that flank the chat.

### Stream G — Chat pane (proper)

**Scope**: Replace G2's placeholder with a proper chat composer + message renderer.

**Inputs**: Stream E (orchestrator events), Stream A (`AIEngine.readHistory`).

**Outputs**: `src/tui/panes/chat/`:
- `Chat.tsx` — message list (assistant deltas, tool calls, tool results), composer at bottom
- Streaming: assistant text appears token-by-token via engine event subscription
- History: on task switch, call `engine.readHistory(sessionId)` and render past messages
- Tool call rendering: collapsed by default, expand on enter
- Composer: multi-line input, `enter` submits, `shift-enter` newline

**Done when**: Switching between tasks in the sidebar swaps history; new prompts stream live.

**Agent prompt seed**:
> Build kobe's chat pane. Reuse opencode's message rendering pattern (`refs/opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` lines 1064+). Subscribe to `Orchestrator.subscribeEvents(taskId)`. On task change, fetch `engine.readHistory(sessionId)` and prepend. Tool calls render collapsed; `enter` expands. Composer at bottom, multi-line, `enter` to submit. ~500 LoC.

---

### Stream H — File tree pane

**Scope**: Right-rail pane: list files in active task's worktree, mark changed files.

**Inputs**: Stream B (worktree path), Solid sync to active task signal.

**Outputs**: `src/tui/panes/filetree/`:
- `FileTree.tsx` — recursive tree of worktree root, `.gitignore` respected
- Tabs at top: `All` | `Changes` | `Checks` (Checks empty for now, fills in Wave 4)
- `Changes` tab: only files with `git status` modifications
- Cursor nav, `enter` emits `openFile(path)` (consumed by Diff pane)

**Done when**: Tree renders for active task; All/Changes toggle works; selecting a file emits the event.

**Agent prompt seed**:
> Build kobe's file tree pane. List worktree files (respect .gitignore via `git ls-files --cached --others --exclude-standard`). Three top tabs: All, Changes, Checks. `All` = full tree; `Changes` = `git status --porcelain` files; `Checks` = empty placeholder. Cursor nav, `enter` emits `openFile(path)`. ~300 LoC.

---

### Stream I — Diff/preview pane

**Scope**: Center pane content — show file content or diff when a file is selected.

**Inputs**: Stream B (worktree), Stream H (`openFile` event), `refs/opencode/.../component/dialog-diff.tsx` as the rendering reference (the user wrote this).

**Outputs**: `src/tui/panes/preview/`:
- `Preview.tsx` — receives selected file path
- Two modes: file view (full content, syntax-aware later — for v1 plain text) and diff view (`git diff <branch-base> -- <path>`)
- Mode switched via tabs (`File` / `Diff`)
- Reuses `DiffLine` component from `dialog-diff.tsx`
- Multi-tab support (each opened file = a tab)

**Done when**: Selecting files in the file tree opens them in the preview; diff toggle works.

**Agent prompt seed**:
> Build kobe's preview pane. Lift the `DiffLine` rendering pattern from `refs/opencode/.../component/dialog-diff.tsx`. Two modes: File (cat) and Diff (git diff vs branch base). Multi-tab — each opened file is a tab; close with `x`. Subscribes to `openFile` from Stream H. ~350 LoC.

---

### Stream J — Terminal pane

**Scope**: Embedded terminal scoped to active task's worktree.

**Inputs**: Stream B (worktree path), Stream E (active task signal).

**Outputs**: `src/tui/panes/terminal/`:
- `Terminal.tsx` — pty wrapper (`node-pty` or Bun equivalent)
- Spawns `$SHELL` with `cwd = worktreePath`
- Renders into an opentui scrollback area; key passthrough
- On task switch, kill old pty and spawn new
- **Decision needed**: do we keep one pty per task (multiplexed) or one pty global that follows active task? Default proposal: one pty per task, kept alive while task is in `in_progress`.

**Done when**: Terminal in the bottom-right pane runs commands in the active task's worktree.

**Agent prompt seed**:
> Build kobe's terminal pane using `node-pty` (or Bun's spawn-with-pty if simpler). One pty per task; kept alive while task status is `in_progress`. Render output into an opentui scrollable box; pass keystrokes through. On task switch, swap to the new task's pty (or spawn one if none). ~400 LoC.

---

### ▶ Gate G3 — "Full 5-pane demo"

Wire all five panes into the final layout matching DESIGN.md §1's Conductor screenshot:

- Left: Sidebar (F)
- Center top: Preview (I) with file tabs
- Center bottom: Chat (G) composer
- Right top: File tree (H)
- Right bottom: Terminal (J) (and Setup Spotlight placeholder)

Manual check:
- [ ] Layout matches the Conductor screenshot grammar
- [ ] All five panes visible and interactive
- [ ] Focus cycles between panes (`tab` / `shift-tab`)
- [ ] Active task drives all panes consistently

---

## Phase 1 — Wave 4 (sequential, single agent each)

Polish + the bits that need cross-pane coordination.

### Stream K — Status flow + checks pane

- Buttons / commands to transition `in_progress → in_review` (e.g. `r` key)
- `done` and `canceled` transitions
- Checks pane (the third tab in file tree): show test/build/lint status. v1: shells out to `bun test` and `bun run typecheck`, parses exit codes, renders pass/fail. Per-project config later.

### Stream L — PR button + cmd-k task switcher

- Top-bar button / command to open a GitHub PR via `gh pr create`. AI-generated description from session messages.
- `cmd-k` task switcher (already lifted from opencode's command palette — wire it up to task list)

### Stream M — Multi-task end-to-end QA

- Run 5+ concurrent tasks in different repos
- Profile memory + CPU
- Fix what's broken
- Document known issues in `docs/PHASE1-NOTES.md`

### ▶ Gate G4 — Phase 1 ship — **CLOSED 2026-05-09 (v0.1.0)**

- [x] All Wave 1–4 streams committed
- [x] DESIGN.md §11 open questions resolved or explicitly deferred
- [x] CLAUDE.md updated with Phase 2 entry plan
- [x] HANDOFF.md replaced or updated for next session

Shipped as `@sma1lboy/kobe@0.1.0` on npm (see [`CHANGELOG.md`](../CHANGELOG.md#010---2026-05-09)
for the full feature manifest). Wave 4 polish landed via the
worktree-agent merges between 2026-05-09 morning and afternoon
plus the inline approval flows (ExitPlanMode + AskUserQuestion).
Two known regressions caught post-ship by the new approval-flow
behavior tests (composer lock not visible, AskUserQuestion crash);
tracked in `test/behavior/approval-flow.test.ts` `test.skip` notes
for follow-up.

---

## Parallelism budget

| Wave | Parallel streams | Critical path stream | Wall-clock units (rough) |
|---|---|---|---|
| Phase 0 | 1 → 2 | 0.1 → 0.2 | 1.5 |
| Wave 1 | 4 | A (engine port) | 2.0 |
| Wave 2 | 2 | E (orchestrator) | 1.5 |
| Wave 3 | 4 | G (chat) or J (terminal) | 2.0 |
| Wave 4 | 1 | K (sequential) | 1.5 |

Total wall-clock: **~8.5 units** with 4-way parallelism vs. ~14 sequential. The win compounds in Wave 1 and Wave 3 where parallelism is highest.

A "unit" is roughly one focused agent session (~half a day of human-attended work). Calibrate as we go.

---

## How to spawn a stream agent

Use the **Agent** tool with `subagent_type: "general-purpose"` (or `Explore` for read-only research streams). Pass the stream's "Agent prompt seed" as the prompt, plus:

1. The full DESIGN.md (or a pointer to it).
2. The stream's row from PLAN.md (this file).
3. Any upstream stream's commit/files it depends on.
4. The acceptance ("Done when") clause as the success contract.

Constraint: each stream agent gets one focus area. **No cross-stream commits.** If a stream agent finds it needs to modify a file outside its scope, it must surface and ask — not just go in.

---

## Open decisions — resolved 2026-05-08

| # | Decision | Stream | Resolution |
|---|---|---|---|
| 1 | Default theme | D | **`tokyonight`** (matches agent-deck's Tokyo Night palette; already lifted from opencode) |
| 2 | Worktree root | B | **`<repo>/.claude/worktrees/<task-id>/`** (per-repo, gitignored, shared namespace with Claude Code's own agent-spawn worktrees — Wave 4 resolution; do not move back to `.kobe/`) |
| 3 | Branch naming | E | **Auto** `kobe/<slug>-<ulid-suffix>`; user can override per-task |
| 4 | Concurrency cap | E | **4** simultaneous running tasks; configurable via `~/.kobe/config.json` later |
| 5 | Terminal pane | J | **One pty per task**, kept alive while task is `in_progress`, killed on archive |
