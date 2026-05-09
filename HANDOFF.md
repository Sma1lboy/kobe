# Handoff — kobe (Wave 3 → Wave 4)

> Written 2026-05-09 at the end of a long Wave 3 session. Context was about to overflow; Jackson is opening a fresh window inside this directory and wants you to pick up here.
>
> The original Phase-0 briefing is now at [`docs/HANDOFF-v1.md`](./docs/HANDOFF-v1.md). Read it for the project's mission and the Phase 0 → 1 framing. THIS file is what just shipped + what's next.

---

## Read first (in this order)

1. **`CLAUDE.md`** — operating model, hard rules, pane focus + flex-first layout conventions, agent-team / context discipline, "no delete without consent."
2. **`docs/DESIGN.md`** — design philosophy. Especially §1 (Conductor screenshot grammar — partly obsolete now, see §"Direction shift" below), §2.5 + §2.5.1 (state ownership; the §2.5.1 note about "no re-read on done" is now obsolete after the chat refactor — see §"Recent decisions"), §5 (architecture), §10 (data model).
3. **`docs/PLAN.md`** — Phase 0 → 1 stream/wave plan. Waves 0/1/2/3 are done; Wave 4 polish is partly in flight. See gates G0–G3.
4. **`docs/HARNESS.md`** — agent self-test contract (still load-bearing).
5. **`memory/MEMORY.md` index** — important learnings:
   - `feedback_agent_worktree_isolation.md` — agents bypass `isolation: "worktree"` via absolute paths unless brief explicitly forbids it.
   - `feedback_layout_flex_first.md` — flex over hardcoded widths; document hardcodes when unavoidable.

---

## Where we are (state of the binary)

**Wave 3 is shipped.** `bun run dev` boots a 5-pane TUI:

```
┌────────────────────────────────────────────────────────────────────┐
│ kobe — <active task title>                                         │  TopBar
├──────────┬─────────────────────────────────┬───────────────────────┤
│ Sidebar  │ WORKSPACE                       │ FILES                 │
│ kobe     │  [chat] [<file>] [<file>] …     │  All Changes Checks   │
│          │  ┌────────────────────────────┐ │  .gitignore           │
│ ● task-1 │  │ chat OR file/diff preview  │ │  CLAUDE.md            │
│ ○ task-2 │  │  (active tab determines)   │ │  docs/                │
│          │  │ messages: user/assistant/  │ │  src/                 │
│          │  │  tool/system rows          │ ├───━━━━━━━━━━━━━━━━━━━┤
│          │  │                            │ │ TERMINAL              │
│          │  │ > Ask Claude…              │ │  per-task tmux pty    │
│ + Add    │  └────────────────────────────┘ │                       │
├──────────┴─────────────────────────────────┴───────────────────────┤
│ Tasks: [j/k] nav [enter] select [d] delete  …  [tab] cycle [ctrl+1234] focus [ctrl+n] new [?] help [q] quit │
└────────────────────────────────────────────────────────────────────┘
```

### Stack (locked, do not re-litigate)

- **TypeScript + `@opentui/core@0.2.4` + `@opentui/solid@0.2.4` + `solid-js@1.9.10` + Bun**.
- Tests: vitest (`bun run test`), behavior tests via PTY driver under `node-pty`.
- Linter: biome 1.9.4. `bun run lint`.

### Tech surfaces

- **Engine**: `src/engine/claude-code-local/` — subprocess wrapper around `claude` CLI. Spawn / resume via `--resume <id> --output-format stream-json`. Stream-json parser normalizes events to a discriminated union (`assistant.delta` / `tool.start` / `tool.result` / `usage` / `done` / `error`).
- **Orchestrator**: `src/orchestrator/core.ts` — `class Orchestrator`. Methods: `createTask`, `runTask`, `pauseTask`, `archiveTask`, `deleteTask`. Wraps `TaskIndexStore` (`~/.kobe/tasks.json`, atomic writes + lockfile) and `GitWorktreeManager`.
- **TUI**: `src/tui/` — Solid components on opentui, lifted skeleton from `refs/opencode`.
  - `app.tsx` — Shell, FocusContext provider, NewTaskDialog, StatusBar, layout.
  - `panes/sidebar/` — task list (Stream F).
  - `panes/chat/` — chat (just refactored to single `messages[]` model).
  - `panes/filetree/` — Stream H.
  - `panes/preview/` — Stream I (multi-file tabs, File / Diff modes).
  - `panes/terminal/` — Stream J (tmux backend; `node-pty` doesn't work under Bun for this).
  - `context/focus.tsx` — FocusContext (`useFocus().focused / setFocused / is(pane) / cycle`).
  - `context/keybindings.ts` — global keymap, `inputFocused` opt to gate single-letter shortcuts.
  - `lib/keymap.tsx` — `useBindings` thin wrapper. Modifier-aware (`{key:"k"}` does NOT match `ctrl+k`).
- **Behavior tests**: `test/behavior/` — PTY-driven, fake-engine HTTP side-channel on `KOBE_TEST_FAKE_PORT`.

---

## What just shipped (last ~5 hours of work)

In rough chronological order, all on `main`:

1. **Wave 3 G+H+I+J** — chat / filetree / preview / terminal panes. 5-pane layout integrated.
2. **Tabbed center column** — chat tab + per-file tabs, per-task tab state.
3. **Visual polish — agent-deck style** — borders, CAPS pane headers, `[key]` chip hotkeys, transparent backgrounds, tokyonight default.
4. **FocusContext** — `useFocus()` exposes `focused / setFocused / is(pane) / cycle`. ctrl+1/2/3/4 jump, tab cycle, click-to-focus, green border on focused pane.
5. **Composer key gating** — when workspace pane is focused, single-letter shortcuts (`?`, `n`, `q`, `tab`) are NOT registered so the chat input can receive them as typed text. Modifier-prefixed (`ctrl+...`) always work.
6. **Pane bindings gated on dialog state** — `isFocused(pane)` in app.tsx returns false whenever a dialog is open. Stops sidebar's `d` (delete-task) from firing on every `d` typed into a path field.
7. **Delete task + base-ref picker** — sidebar `d` opens confirm; new-task dialog has 3 fields with a branch picker (up/down navigates `git for-each-ref`, prefills the input, enter commits).
8. **Engine session registry leak fix** — pump's finally block now `unregister()`s the session id, so the next `resume(sessionId,...)` doesn't blow up with `duplicate sessionId`.
9. **Chat state refactor (← BIG ONE)** — was `past + live + draftUser` tri-state which lost user-prompt history (each new submit overwrote `draftUser`). Now a single chronological `messages: ChatRow[]` per opcode's design. user submits append, assistant deltas append/coalesce, tool starts/results pair by name. 20 unit tests in `test/tui/chat.test.tsx` cover all invariants including multi-turn integration.

### Known failing tests (as of last run, 2 of 33 behavior tests)

- `test/behavior/sidebar-delete.test.ts > pressing 'd' on the sidebar cursor + confirm deletes …` — the test creates a task, waits for the title in the sidebar. Possibly affected by the chat refactor or dialog-gate change. **Has not been re-investigated post-refactor; investigate first.**
- One other behavior test was failing per the last `bun run test:behavior` count (`2 failed | 31 passed`). Identify which by running and re-investigate.

`bun run test` (unit) is green: 20/20 chat store tests pass, all other unit tests too.

---

## Direction shift — Jackson's new product priorities

This is what Jackson said in the very last message before context ran out. Treat as the PRD update.

### 1. Drop the 5 sidebar status groups (for now)

Currently: `In progress / In review / Backlog / Done / Canceled / Error`. This was modeled after Conductor's "is this PR merged" workflow — kobe doesn't manage that. Simplify the sidebar grouping.

Status management (the whole `done → in_review → done → archived` flow) is **deferred to an experimental feature**, not Wave 4.

### 2. Multi-repo sidebar

Today, each task carries its own `repo` field. The sidebar groups by status, not by repo. Jackson wants the sidebar to be **repo-grouped** with sessions under each repo — top-level rows are repos, nested rows are sessions belonging to that repo.

Likely shape:
```
my-frontend (3)
  ● fix login redirect bug
  ○ refactor auth service
  ○ add password reset

api-server (1)
  ● migrate to fastify

+ Add repo
```

### 3. Each session = one worktree, can have multiple chat tabs + file view

Today: a "task" = a session = a worktree = ONE chat. Jackson wants ONE session (worktree) to host **multiple chat tabs** (different conversations against the same codebase) plus **file view tabs** (current center-column behavior). The center column already has multi-tab support — just need the data model to allow more than one chat per session.

Implication: `Task.sessionId: string | null` → `Task.sessionIds: string[]`. Or introduce a separate `Conversation` entity per task. This is a real schema change.

### 4. Auto-update mechanism

Jackson wants kobe to push to a specific repo, and on every launch check that repo for updates. Likely a small "newer version available" banner. **Out of scope for the current session — note for Wave 4.**

### 5. Status management → experimental feature

Don't remove the existing status state machine — it works and tests cover it. But UI should hide the 5-group sidebar and the related transitions (`d` key for delete still useful). Make status management an opt-in experimental flag (`KOBE_STATUS_FEATURE=1` or similar). Defer the actual experimental wiring; just simplify the default sidebar.

---

## Suggested next steps for the new session

In priority order:

1. **Investigate + fix the 2 failing behavior tests** (sidebar-delete and one other). Run `bun run test:behavior 2>&1 | grep FAIL` to identify. Likely the chat refactor changed enough render output to break a substring assertion. Fix is probably small.

2. **Sidebar simplification** (#1 + #2 above): strip the 5 status groups, replace with repo-grouped sessions. Each repo row has a count, expand/collapse semantics, `+ Add repo` at the bottom. The `Task` type already has `repo`; just group by it. Conditional re-introduce statuses behind the experimental flag later.

3. **Multi-chat-per-session** (#3): bigger schema change. Probably:
   - Add `Conversation = { id; sessionId: string | null; title: string; createdAt; updatedAt }`
   - `Task` retains worktree + branch info, gets `conversations: Conversation[]`
   - Center tab strip shows `[chat: <conv1>] [chat: <conv2>] [<file>] [<file>]`
   - Default: one chat per session; user can `cmd+t` (or similar) to open a new chat tab against the same worktree
   - Each chat tab subscribes to its own sessionId

4. **Auto-update** (#4): defer until 2 + 3 are stable. Simplest approach: ship `kobe --check-updates` that compares `package.json` version against a release manifest URL, prints a one-line banner if newer.

5. **Document the chat refactor** in `docs/DESIGN.md` §2.5.1 — the previous note saying "no re-read on done" is now correct again (single messages array doesn't need it), but it should also say "do not split state into past/live/draftUser; opcode keeps one array, we follow." Update the §2.5.1 to reflect the rewrite.

6. **Long-term: rename `kobe`** — still a city codename. When the product gets a real name, rename the repo + binary + docs.

---

## Useful pointers

- **Run dev**: `bun run dev` (preloads `@opentui/solid/preload`).
- **Run all tests**: `bun run test` (unit + type tests, vitest), `bun run test:behavior` (PTY-driven).
- **Lint**: `bun run lint` (biome). Auto-fix: `bun x @biomejs/biome check --write <file>`.
- **Smoke**: `timeout 5 bun run dev > /tmp/smoke.log 2>&1` then grep for expected text.
- **Fake engine for tests**: set `KOBE_TEST_ENGINE=fake` and `KOBE_TEST_FAKE_PORT=<port>`. Test scripts the engine via `POST localhost:<port>/script` with `{sessionId, events}`. See `test/behavior/fake-engine.ts` + `src/tui/app.tsx` `mountFakeEngineServer`.
- **Tasks live at**: `~/.kobe/tasks.json`.
- **Worktrees live at**: `<repo>/.kobe/worktrees/<task-id>/`.
- **Claude Code session JSONL at**: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` (read via `engine.readHistory(sessionId)`).

---

## Hard rules to remember (from CLAUDE.md)

- **NEVER** include `Co-Authored-By: Claude` or any AI/Anthropic attribution in commits.
- **NEVER** delete files unless Jackson explicitly says "delete" or "remove" in that conversation.
- **NEVER** use `--no-verify`, `-c commit.gpgsign=false`, or any git override.
- **Agents in worktree isolation**: brief MUST forbid absolute paths into the main repo or they'll silently escape (caused merge chaos this session — twice).
- **Layout: flex-first**. `width={N}` only with documented rationale (sidebar's 42, terminal-grammar fixed glyphs, modal centering).
- **State: delegate to Claude Code where possible**. The chat now follows opcode's single-array pattern — append, don't reload.

---

## Open questions for the new session

1. Do we keep the existing `TaskStatus` union (`backlog | in_progress | in_review | done | canceled | error`) on disk even though the sidebar no longer renders by status? Probably yes — the status drives concurrency cap (max 4 in_progress) and would be needed if status feature comes back.
2. For multi-chat-per-session, does each chat have its own Claude Code session id, or do they all share the worktree's session id? (If they share, message ordering across chats becomes ambiguous; opcode-style separate session per chat is cleaner.)
3. Default sidebar grouping when there's only ONE repo — collapse the repo header? Or always show the level?

Pick these up with Jackson before implementing.

---

Good luck. The codebase is in good shape — visual polish is solid, behavior tests cover the load-bearing flows, the chat refactor closed the most painful design wart. The next session is mostly about the new sidebar shape + multi-chat support.
