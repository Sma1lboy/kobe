# Changelog

## 0.7.86

### Patch Changes

- b72130d: fix: `kobe add` (and every task-creation path) now provisions the repo's project row

  The sidebar's PROJECTS entries are the repos' `kind:"main"` tasks, but nothing in the daemon world created them — `kobe add` saved the repo and adopted worktrees (tasks appeared live) while the PROJECTS list never updated. `kobe add` now ensures the main task, via the daemon when one runs so a live TUI shows the project immediately; `createTask`/`adoptWorktree` also self-provision it, so the new-task dialog on a brand-new repo and hook-adopted worktrees get their project row too.

- 65534ee: Modal keybinding precedence is now declared data, not a React effect-order accident.

  The dialog barrier and dialog-body bindings used to resolve their precedence by which effect happened to commit first (sibling tree order) — documented only in a comment and pinned by no test. Registrations now carry an explicit modal scope (`modalOwner` on the barrier, membership stamped via `ModalScopeContext`), and a pure `insertRegistration` slots the barrier below its members under either registration order; dispatch itself is unchanged. Workspace-host dialog/page gating is consolidated into named, framework-free predicates (`workspacePagesClosed` / `settingsCloseKeysEnabled`) with unit tests, including the negative case (open dialog disables workspace chords) and the deliberate settings-close exemption. No chords added, moved, or rebound.

- f5007f3: refactor: split the over-cap orchestrator core + task-index store back under the file-size cap

  `orchestrator/core.ts` and `orchestrator/index/store.ts` were only passing CI via file-size exemptions. Both are now under ~500 lines, behaviour-preserving and with an unchanged public interface: the store's pure lock-retry + on-disk codec moved to `index/store-codec.ts`; the orchestrator's git-worktree side-effects (allocate / materialise / adopt + their locks) moved to a `WorktreeCoordinator` collaborator, its in-place task-field edits to a `TaskEditor` collaborator, and its pure path/repo-key helpers to `core-helpers.ts`. The `Orchestrator` and `TaskIndexStore` classes keep every public method as a thin delegator, so no caller changed.

- 2727624: Boot now issues every saved repo's main-task ensure concurrently instead of one serial daemon round-trip after another.

  `ensureRepos` looped `await orchestrator.ensureMainTask(repo)` per repo, so with N saved repos the pre-first-paint boot paid N latency-bound round-trips back to back. The daemon transport already pipelines id-correlated requests and the store's saveChain/file-lock serialize the writes, so the calls now go out together via `Promise.all` — collapsing N RTTs into ~1 wall time. Per-repo error isolation is unchanged: a failing repo is caught and logged, and no longer blocks (or rejects) the others.

- 74576ca: Inbound pty-frame routing is now O(1) per chunk instead of O(open-tabs).

  Every open terminal tab used to register its own `pty.data`/`pty.exit` handler on the one shared pty-host client, so the client walked N handlers (N-1 pure key-mismatch rejections) for every chunk an interactive engine streamed — on the busiest inbound path. A single keyed dispatcher now installs once per client and does one `Map` lookup per frame; each hosted handle registers/deregisters through its existing teardown so detach/kill/park never leave a stale route. Behavior is identical: a frame still reaches exactly its own tab and unknown keys drop.

- 4577f28: perf: task focus switches no longer fsync a disk rewrite.

  `setActiveTask` (the most frequent action in the TUI — every task/focus switch) used to call `store.update(id, {})` with an empty patch purely to bump `updatedAt` for the sidebar's `recent` sort. That still paid a full fsync'd read-merge-write (flock + read + merge + `handle.sync()` + rename) plus a full-list `task.snapshot` broadcast on every switch, all to move a field the default sort never reads. Recency is now a cheap in-cache `updatedAt` bump (`store.touchRecency`) that notifies listeners so `recent` still reorders live, but flushes lazily on the next real mutation — dropping the per-switch fsync'd disk write. The durable last-focused id is unaffected (it persists eagerly via `state/last-active.ts`).

- 893cafe: Sidebar: the task whose terminal you're currently viewing no longer draws kobe's own engine spinner. The live terminal already shows claude/codex's own zero-latency spinner, so the sidebar row defers to it instead of animating a duplicate that's necessarily a beat behind. Unfocused rows still spin (their terminal isn't on screen, so kobe's signal is the only liveness cue), and a materializing worktree job still spins even on the viewed row since no terminal exists yet.
- d8a733a: Extract the remaining terminal tab/split decision logic out of the React components into the framework-free `terminal-tabs-core` module — the engine-tab resume-vs-pin argv choice (`engineTabArgv`), the tab exit policy (`tabExitAction`: close / one-shot resume / degrade to shell), the split collapse-to-unsplit rule (`collapseSplit`), and the is-split keybinding gate (`isTabSplit`) — with unit coverage for each. Behavior-invariant; `TerminalTabs`/`TerminalSplit` now only dispatch.
- e1957c0: A terminal reset whose fresh spawn fails now shows the spawn error instead of a dead snapshot.

  `registry.reset()` kills the old PTY before spawning the replacement, so when the acquire half threw (shell missing, spawn EACCES) the pane kept rendering the dead shell's last screen while the error message sat in state the UI never showed. The failed-reset path now clears the pane to the same "terminal unavailable" error state as a failed first acquire. Also adds a scripted fake PTY registry (`pty-scripted.ts`) so the pane's error/exit paths are covered by fast render tests with zero subprocesses.

- fa06dd8: perf: the daemon's transcript-activity probe walks each worktree's transcript dir once per tick, not twice.

  Each ~1.5s tick used to make two independent directory listings of the same on-disk transcript store per local worktree — `latestTranscriptMtime` (a readdir + stats, or a full `~/.codex/sessions` date-tree walk) then the turn detector's `latestCompletion` (another walk). The detector already finds the newest file's mtime while locating the latest completion, so it now surfaces both from a single scan (`latestActivity`), and the probe drops the redundant mtime call for claude/codex — one listing per probe, half the stats — while copilot/custom engines keep their single existing walk. The published activity facts (mtime/completionId/completionAt) are byte-identical.

- 06dacb9: Web RPC exposure now derives from the daemon handler registry (`web: true` per entry) instead of a hand-maintained allowlist, and the web transport's error envelopes share the socket's `shapeDaemonError` policy.
- 2d14409: perf: reuse one scratch cell in `xtermLineToChunks` instead of allocating per cell

  `@xterm/headless`'s `line.getCell(x)` allocates a fresh cell object on every call, and the terminal render path called it for every cell of every converted line — the dominant per-cell allocation on that hot path. It now threads one shared scratch cell into `getCell(x, cell)` (xterm's documented reuse fast path), lazily seeded once program-wide, so line conversion allocates zero cells after warmup. Pure allocation change: the two-pass structure and the `minLast` cursor-tail invariant are untouched.

## 0.7.85

### Patch Changes

- d5cbbd3: Tab titles follow the live process, and `kobe api pty-list` exposes it headlessly.

  The tab strip's naming precedence is now manual rename > live OSC window title > first-prompt auto-title > vendor default — so a claude session's own dynamic title ("✳ …" conversation summary) names its tab while it runs, instead of only surfacing when no auto-title existed. The pty host now tracks each session's last OSC 0/2 title (plain string scan with a cross-chunk carry — still no VT emulation) plus pid and command, `pty.list` reports them, and a new read-group verb `kobe api pty-list` lists hosted sessions without a TUI attached; it never spawns a host (no host → empty `sessions`). Note: a pty host started before this release keeps serving the old `{ key, alive }` shape until it naturally turns over.

- c6d0641: fix: reattached terminal sessions repaint, dead engine tabs resume

  A same-size reattach (TUI restart, park-sweep wake) raised no SIGWINCH, so nothing repainted the ring-buffer replay and the engine's UI came back as a garbled/stale screen until a manual window resize — the hosted backend now wiggles one row and back after a live reattach, tmux's attach behavior. An engine tab whose child died while the TUI was away now resumes its conversation (`--resume <sessionId>`, one attempt) instead of silently degrading to an empty shell.

## 0.7.84

### Patch Changes

- 2fba727: perf-golden: a release-ritual performance doctor (`bun run perf:golden`).

  Ten end-to-end golden testcases against throwaway sandbox infrastructure — CLI cold start, VT 1MB parse throughput, daemon connect+replay and RPC p50, PTY spawn→first output, park→wake replay latency, hot-tab memory cost, park heap reclaim, and standalone-binary compile time + size + boot smoke (the native-addon red line). Every ceiling lives in one GOLDEN table, set 2-3× the reference numbers so it flags structural regressions, not machine jitter; `--fast` skips the binary metrics. Wired into the release gates and documented in docs/HARNESS.md §Performance contracts.

## 0.7.83

### Patch Changes

- 059191e: Dev-mode keymap diagnostic: dispatch now warns when one keypress matches two ENABLED bindings.

  Two enabled entries sharing a chord resolve by LIFO stack order, which the React migration inverted (ancestors on top) — the class of bug behind ctrl+w failing to close a split leaf. Under `KOBE_DEV=1` (all dev/dev:sandbox/dev:mock scripts) the dispatcher scans for a shadowed second match on every hit and logs it once per chord, respecting modal barriers. Production keeps the read-one-config-on-hit fast path untouched.

- 0462dd7: PTY parking: hidden terminal tabs release their in-memory terminal after 2 minutes.

  Every open tab used to keep a full headless-xterm instance (live grid + scrollback) resident for the life of the TUI — the workspace host sat at 250-300MB with many tabs and was the first process killed under memory pressure. The registry now sweeps every 30s and detaches handles that have had no visible pane for 2 minutes; the engine/shell keeps running untouched in the pty host, whose byte ring buffer remains the authoritative history. Switching back reattaches and replays — the exact same path a TUI restart uses, so revived content is identical. Visible panes, split leaves, and non-persistent backends are never parked, and sending a prompt to a parked engine tab transparently wakes it first.

## 0.7.82

### Patch Changes

- caa435d: ctrl+e now offers "shell" alongside the engine vendors — a plain terminal tab as a first-class tab type.

  Previously the only way to get a bare shell tab was opening an engine tab and quitting it. The picked shell tab is a regular command tab: named by its live foreground process, closes itself when the shell exits, and never touches the repo's preferred-engine record.

## 0.7.81

### Patch Changes

- 9698d89: Opening kobe now lands on the last-focused task again instead of the first task in the list.

  The orchestrator restores the persisted focus at construction, but the daemon only published the `active-task` channel on an explicit focus change — a fresh daemon's connect-time replay carried tasks and no focus, so every newly attached TUI (and the web dashboard, and `kobe api`'s active-task resolution) fell back to the top of the task list. The daemon now warms the channel with the restored focus at startup, and the workspace host adopts a late-arriving restored focus once (never yanking a selection the user already made). tmux direct mode is untouched — it reads the in-process signal, which was already correct.

## 0.7.80

### Patch Changes

- d1ff9ff: Quitting claude/codex inside an engine tab now degrades the tab to a shell again instead of closing it. The hosted PTY backend's `kill()` early-returned once the child had already exited, so the pty host kept the dead session record under the tab's key; the degraded shell's `pty.open` then reattached that corpse (spawn spec ignored, `alive: false`) and died instantly, which routed the exit through the command-tab close path. A kill on an already-dead handle now still tells the host to forget the session, which also un-breaks F5 reset of a dead shell and stops dead session records leaking in the host on tab close.
- 1f8190a: Fix ctrl+w/F2 not reaching split leaves, and split leaf-1's corner tag freezing on "zsh".

  While a workspace tab was split, ctrl+w and F2 were always captured by the tab-level close/rename bindings (React mounts ancestors on top of the keymap stack, inverting the Solid-era precedence), so a split leaf could never be closed or renamed — on a single tab ctrl+w just toasted "cannot close last tab". The tab-level entries now gate themselves off while the active tab is split. Also, a shell tab's own leaf (leaf-1) now tracks its live foreground-process title, so entering claude/vim from the shell updates the split corner tag instead of freezing on "zsh"; engine tabs keep their conversation title.

## 0.7.79

### Patch Changes

- e8595af: fix: the daemon socket client left post-connect socket errors unhandled — an EPIPE while writing to a peer that was mid-exit (the pty-host sweep race) crashed the process instead of rejecting the pending request. Errors now route through the close path so callers' own catch blocks handle them.
- a384442: fix: esc could go permanently dead on open dialogs — a stale text-selection highlight (kept after a copy until the next click) disabled the dismiss binding entirely. First esc now clears the selection, the next closes the dialog; the engine picker's clickable esc label actually closes the card too.
- c35e524: fix: an open dialog now structurally blocks every key from reaching the UI behind it — the keymap gained a modal barrier that cuts off all bindings registered before the dialog opened (the dialog's own keys and its text inputs keep working). Previously each pane had to gate itself on "no dialog open" and any missed gate (the F1 help card was one) let keys operate the background.
- 23a2cfd: feat: split panes draw full box frames by default, with a new Settings → General → Appearance section to switch back to the tmux-style single divider line. The focused leaf's frame lights up in the focus accent in either style.
- b134f0e: feat: the worktrees page judges each worktree with a staleness rubric — dirty tree > open PR > merged PR > 0-commits-ahead-of-main > closed PR > 14-day idle age, strongest signal first with git-only fallbacks when `gh`/GitHub is unavailable. Rows now carry a colored verdict badge (PR open / merged (PR) / in main / PR closed / stale) so it's obvious which worktrees are safe to clean; the badge is advisory and never gates deletion.
- bb3ad91: fix: the worktrees page paints instantly — local signals (dirty, ahead-of-main, age) render first and the slow network lookups (ls-remote, gh PR states) swap in when they land, so a slow or dead remote can no longer hang the page. feat: `lastActive` — kobe now persists the last-focused task globally (last writer wins, no multi-TUI coordination) and opens on it after a daemon restart or fresh launch instead of falling back to the first task.

## 0.7.78

### Patch Changes

- 857d78d: perf: background engine PTYs no longer rebuild their full screen snapshot at output cadence — with no pane subscribed, the grid+scrollback conversion is deferred until the turn poll's next `capture()` (or a resubscribe), cutting per-session CPU roughly to the 1.5s poll rate while output streams unwatched.
- c0e82ea: perf: the embedded terminal's refresh now reuses converted scrollback rows instead of re-converting the full 200-row margin on every frame — scrollback lines are frozen once they leave the live grid, so per-refresh conversion work drops to roughly the visible grid while an engine streams.

## 0.7.77

### Patch Changes

- a9d4546: fix: the daemon's pty-host sweep now resolves the pty socket from its own homeDir instead of the ambient environment. A daemon started against a non-default home (the test suite's temp-home daemons) used to sweep the REAL user pty-host with its own task list — a test's empty snapshot then killed every live engine session on the machine, on every full test run.

## 0.7.76

### Patch Changes

- 6d7538e: fix: the daemon's ChatTab auto-naming pass no longer hammers `tmux list-windows` against a task whose session doesn't exist (never entered yet, or its session was killed). A task whose session misses 3 consecutive polls now backs off exponentially (capped at 30s) instead of retrying every tick forever — this had flooded `daemon.log` to hundreds of megabytes and burned CPU for tasks with a long-dead session. Archiving or deleting a task now also proactively drops it from the poll set. A session that reappears (the user re-enters the task) resets straight back to full cadence.
- db35c08: feat: pane hosts log event-loop stall telemetry — a 1s heartbeat that, after any multi-second freeze, records the stall duration plus rss/heap to client.log, so "the TUI froze" reports can distinguish OS paging from an in-process block.
- 7f73b9e: fix: cap `client.log` and `daemon.log` at 10MB with single-generation rotation, and hard-throttle the pane reconnect-failure log after 100 attempts until a successful reconnect resets it. Neither log had a size cap before — an incident with dozens of orphan panes spamming reconnect errors grew `client.log` to 736MB and `daemon.log` to 345MB; no long-lived process can grow either file unboundedly now.
- f13334e: feat: quick-fork (ctrl+f) opens the quick-task composer from a focused chat tab, seeded with the active task's repo/branch/engine, and creates a child task on submit. The `chat.fork.new` chord (KOB-74) was previously declared in the keymap with no registration — it now actually fires.
- 46911cc: Internal: split `cli/api-cmd.ts` (was ~1362 lines, over the file-size cap) into `cli/api/{types,flags,schema,runtime,handler-helpers,handlers-tasks,handlers-fanout,verbs}.ts`, with `api-cmd.ts` kept as the dispatcher + stable re-export barrel. Pure mechanical refactor — `kobe api schema --all` output is byte-identical before/after, and all existing tests keep importing from `./api-cmd.ts` unchanged.
- b80b4e8: feat: the pure-tui workspace host now opens the update page (`u`) as an in-place swap, same shape as the worktrees page, instead of leaving it unreachable there. `UpdatePage` gained an `onClose` seam so its close path no longer exits the whole process; the post-update self-replace still hands off to the shell updater and exits, but now shows a status line first.
- f26285c: Add F6 as the keyboard chord to toggle zen mode in the pure-TUI workspace host — previously mouse-click only.

## 0.7.75

### Patch Changes

- cfe1a29: fix: chat-tab close and engine-tab exit now SIGTERM the window's pane process groups before `kill-window` (the same ladder whole-task kills use), so HUP-swallowing engines and pane hosts no longer leak to init. The sweep skips the caller's own group — `kobe engine-tab-exit` runs inside a pane of the window it closes.
- cfe1a29: fix: every pane host now runs an orphan watchdog — if the process is reparented to init (its tmux pane / terminal is gone and no teardown signal ever arrived, e.g. the parent chain was SIGKILLed), it exits within seconds instead of living forever with a revoked tty. Complements the existing exit-signal backstop, which only fires when a signal is actually delivered.

## 0.7.74

### Patch Changes

- 4b9a725: Restore the four tmux pane hosts lost in the Solid removal — `kobe tasks` (the Tasks rail), `kobe new-task`, `kobe quick-task` (prefix+f), and `kobe update-page` printed "unknown command" since 0.7.73 because only their Solid implementations existed when the Solid TUI was deleted. All four are now React hosts under `tui-react/`, wired back into the CLI with routing tests so they can't be dropped silently again.

## 0.7.73

### Patch Changes

- 8703b91: Embedded terminal: the drawn cursor now follows typed spaces. Trailing blank cells were dropped from the snapshot (the cursor-column seed was clobbered by the visible-cell scan), so the inverse-cell cursor froze at end-of-text while the real cursor advanced; the overlay also pads to the true cursor column as a backstop for backends that trim blank tails.
- b8604d1: Fix two task-pane issues while a dialog is open. Typing into a dialog's text input (e.g. the set-branch field) no longer fires the sidebar's plain-letter shortcuts underneath it — those keys were both triggering actions like delete/archive and being swallowed before the input could read them, because pane keybindings stayed live while a dialog overlaid them. The set-branch flow (sidebar `b`) now lists the repo's local branches with filter-as-you-type — matching the new-task dialog's branch picker — while still letting you type a new name to rename the branch to.
- 7a5b878: Remove the Solid.js TUI — React is now the only UI implementation. The `KOBE_SOLID=1` escape hatch back to the Solid host is gone, and the build/test toolchain no longer registers a Solid JSX transform (React JSX is handled by `@opentui/react`'s per-file pragmas). The tmux-era Solid-only surfaces (`quick-task` / `new-task` window / `update-page` / `tasks-pane`) are retired.
- 98c459e: Embedded terminal: the synthetic cursor cell is hidden while a mouse selection is active (tmux copy-mode behavior). Cursor and selection share the same inverse styling, so a cursor sitting just past the selection read as the highlight overrunning by one blinking cell.

## 0.7.72

### Patch Changes

- 1abdc5f: Embedded terminal sessions now survive quitting kobe AND `kobe daemon restart`. A standalone `kobe pty-host` process (kobe's tmux-server analog, spawned on demand, idle-exits at zero sessions) owns the raw PTYs with a per-session scrollback ring buffer; the TUI keeps VT emulation local and reattaches on next boot with a full replay (protocol v4: `pty.*` requests + targeted `pty.data`/`pty.exit` frames). Quitting the TUI detaches instead of killing; closing a tab, resetting, or archiving a task still ends its session, and `kobe reset` now also stops the pty host. `KOBE_TERMINAL_BACKEND=bun-pty` restores the old local-child backend.
- 435e213: The React TUI is now the default implementation for every surface (workspace, settings, help, history, ops, worktrees) — `KOBE_SOLID=1` keeps the retiring Solid implementation as an escape hatch, selected in one place (`uiFramework()` in env.ts). Fixes the silent exit-1 boot crash after the flip: the upstream @opentui/solid preload compiled the React files as Solid JSX; kobe now ships its own JSX loader rule (`scripts/jsx-plugin.ts`) — Solid transform everywhere except `src/tui-react/**`, whose per-file React pragmas are honored — shared by the dev preload, bunfig, and the production build.
- 3b21da4: Ports the workspace cluster (three-column Sidebar | TerminalTabs | FileTree layout, split-pane terminal, tab strip, turn-status polling, files activity badge) to React under `src/tui-react/workspace/`, the final piece of the Solid→React migration (issue #16). React is now the default runtime for the native workspace, settings, help, history, and ops surfaces — set `KOBE_SOLID=1` to fall back to the legacy Solid host during the transition window. The worktree-management page overlay isn't ported yet and shows a placeholder until it lands.
- 43ab11c: Terminal tabs now follow one model: every tab is a shell, an engine is just a process running in it. Tab default names are "$process $ordinal" ("claude 3", "shell 5") instead of "tab N"; split shell leaves and tab labels track the live foreground process via OSC window titles ("vim", "htop"), with engine titles normalized to one vocabulary ("✳ Claude Code" → "claude"). Typing `claude` inside a plain shell now attaches the same turn-status chip (●/✓) as a kobe-launched engine tab, and it detaches when the process exits. Fixes: a tab degraded to a shell no longer reopens as a fresh claude after restart; closing the engine leaf inside a split no longer leaves a stale turn chip flapping against a dead PTY; the corner name tag hides when a single leaf survives (the tab label already says it).

## 0.7.71

### Patch Changes

- d43a7ba: Fix the whole-page twitch when clicking or switching panes in a split terminal group. Several causes: a plain click set a zero-width text selection that pushed new render content (then cleared it); clicking/switching a split leaf routed leaf focus through the persisted split tree (a state.json write + a full tree re-render), with the divider colour computed eagerly so the whole tree re-rendered to repaint it; and clicking an already-active tab or already-selected task re-created state / re-hit the daemon. Leaf focus is now a local signal with reactive border attributes, zero-width selections render nothing, and the no-op transitions (`selectTab`, task select) short-circuit.
- d43a7ba: Fix closing the engine leaf in a split respawning Claude instead of keeping the surviving shell. The split now collapses back to the single-engine fast path only when the sole survivor is the engine leaf; a surviving shell keeps rendering as itself, and the tab label follows (it shows the shell's name, not the stale engine conversation title).
- d43a7ba: Clearer terminal tab / split naming. A normal (single) tab is "tab N"; only a tab split into multiple leaves is a "group N". In a split, the engine leaf shows the conversation's first-prompt title (matching the group label) instead of a static "claude", and split shell leaves are named "shell" (deduped: "shell", "shell 2"). `F2` while split renames the active leaf.
- a6b35eb: Fix: clicking the embedded terminal now focuses it. opentui mouse events don't bubble to the workspace wrapper, and the terminal's own selection handlers consume the click, so a bare click inside the terminal never reached the global focus setter — you had to tab/arrow over from the task list. The pane now requests focus on click (and, when split, also selects the clicked leaf).
- c06121b: Fix the embedded-terminal cursor drifting away from the text when typing CJK / wide characters. Two causes: (1) the inline cursor cell counted code points instead of terminal cells, so every wide glyph before the cursor shifted it a column — now it walks by display width (shared `charWidth`/`displayWidth` moved to `lib/display-width.ts`); (2) the real host cursor was parked invisibly at (0,0), so the OS IME / pinyin candidate window had nothing to anchor to — it now tracks the embedded cursor's screen cell (still invisible; the inverse cell stays the visible cursor).

## 0.7.70

### Patch Changes

- 4de9a6b: Split layouts now persist across restart. A group (tab) split into `claude | shell` — or a shell where you ran `claude` yourself — comes back with the same layout when you reopen kobe: `leaf-1` resumes the tab's engine session as before, and the other leaves respawn their shells fresh. The split tree is frozen onto the tab and stored in `state.json` (previously it lived only in memory and vanished on restart). Internally this replaces the module-level `splitsByTab` map with a single source of truth on the tab object.
- 4de9a6b: Pure-TUI pane navigation: `F4` cycles pane focus (sidebar → workspace → files, forward-only) and is reserved from terminal passthrough, so it behaves identically from every pane including inside the embedded engine terminal — closing the workspace → files two-hop gap. `ctrl+l` (dead slot in the 3-pane host) now focuses the workspace terminal, and `Right` from the sidebar jumps into the engine, matching the tmux Tasks pane. `tab`/`shift+tab` stay with the shell and claude (completion, plan-mode) — deliberately not bound to the cycle.
- 4de9a6b: Split naming semantics fixed: the whole tab is the "group" (default tab title is now `group {n}`), and each split pane carries its own corner-tag name — default is the basename of what it runs ("claude", "zsh", with a suffix for duplicates), and `F2` while split renames the active pane (falling through to rename-tab when unsplit, same contextual shape as `ctrl+w`). Previously every pane was mislabeled `group {n}`.

## 0.7.69

### Patch Changes

- c29e9d8: Chrome animations, first batch (design review follow-up): the sidebar running badge now animates with the task engine's own brand spinner (claude gets Claude Code's `·✢✳✶✻✽` star oscillation; other engines keep braille) via a new engine-registry `spinnerFrames` slot; a background tab's turn-complete ✓ pulses emphasized for ~600ms when it lands; toasts slide in from the right; a materializing worktree row shows an indeterminate partial-block comet sweep ahead of the word. All of it sits behind a new Settings → General → Reduced motion toggle (persisted + daemon-fanned like theme/transparent) that degrades the spinner to Claude Code's slow pulsing-dot form and turns the other effects off. Also: the file tree's `−N` deletion counter now uses the same typographic minus as the sidebar.
- c29e9d8: Split panes now carry a name: while a tab is split, each pane shows a corner tag (`group 1`, `group 2`, …, numbered in reading order like tmux pane numbers) in its top-right cell, with the focused pane's tag lit in the focus accent — tabs already had titles, panes had no identity at all.

## 0.7.68

### Patch Changes

- f3482b2: The embedded terminal's mouse wheel now behaves like a real terminal emulator: apps that enable mouse tracking (claude's transcript, vim, less) receive the wheel and scroll natively, fullscreen apps without it get the classic arrow-key fallback, and only a plain shell scrolls kobe's local scrollback (same channel as ctrl+pgup/pgdn). It also supports copy-on-select: drag to select text and it lands on the system clipboard via OSC52 the moment you release — the tmux copy-mode convention, working over SSH too.

## 0.7.67

### Patch Changes

- 2f865bd: ctrl+t now opens the new tab with your preferred engine — the project's last actively-chosen vendor (ctrl+e and dialog picks record it), else the Settings global default, else claude — the same resolution chain the new-task dialog uses, instead of always inheriting the task's engine.

## 0.7.66

### Patch Changes

- cafc139: The embedded terminal's basic-16 ANSI palette now uses Tokyo Night's published terminal colors instead of xterm's 1990s primaries, so `ls`/`eza` output and other bare-ANSI coloring reads as one coherent modern scheme (truecolor and 256-color output were always bit-exact and are unchanged).
- 56b6885: Fix the embedded terminal freezing on the last frame during rapid redraws: the snapshot pass skips half-painted frames while a synchronized-output block is open, but under back-to-back redraws a new block could open before the closing write's refresh landed, so the skip never got a follow-up and the screen stopped updating. The skip now reschedules itself.
- dc42a72: Pure-tui workspace reaches chattab/tasks-pane parity: tab auto-naming from each session's first prompt, per-tab turn-state chips (●/✓/!/○) with background-done toasts, tab persistence across restarts with transcript-verified `--resume`, full Sidebar task lifecycle (n/d/a/r/b/v/pin/move/sort/filter), the Ops-pane `● new` activity badge + zen/Create-PR corner actions on the files column, a worktrees page swap, and last-tab close feedback. Terminal resize no longer trusts pre-layout geometry (the tab-revisit frame-wreck fix), and closing a tab now releases its engine PTY.

## 0.7.65

### Patch Changes

- 40261ba: Exiting the engine CLI inside a terminal tab is now an allowed action, not a dead end: the tab degrades in place to your shell in the same worktree (keeping its title and identity) instead of freezing behind the exit banner. A degraded shell tab closes itself on its next exit; the last tab still keeps the banner + F5 recovery. Internally `TerminalTab` became a discriminated union (engine | command) so the illegal tab shapes can't be represented.
- 40261ba: Fix ctrl+c (and every ctrl-chord) passing into the embedded terminal on kitty-protocol terminals (Ghostty/kitty/WezTerm/iTerm2): the host renderer negotiates the kitty keyboard protocol, so chords arrived CSI-u encoded and were forwarded as garbage — ctrl+c literally typed a `c`. Kitty-encoded keystrokes are now re-encoded to the legacy bytes the embedded CLI expects; ctrl+space maps to NUL and ctrl+punctuation to its classic C0 codes (ctrl+\ SIGQUIT et al).
- 40261ba: Terminal-tab quality-of-life batch: ctrl+e opens a new tab with a chosen engine (pinned to just that tab); tabs are click-to-switch; switching tabs no longer remounts the terminal (fast cycling stopped flashing stale content); unnamed engine tabs auto-title from their conversation's first prompt and carry a per-tab session id so a restart resumes the conversation; FileTree's Enter opens the file in your real editor as a transient tab (diff-mode when the file differs from HEAD); the numbered fallback title is now the content-neutral "Tab {n}"; and ctrl+, swaps the workspace for a full settings page.
- 40261ba: tmux-style split panes inside a terminal tab: ctrl+\ splits right, ctrl+= splits down (new panes run your shell in the same worktree), F3 cycles pane focus, and ctrl+w contextually closes the active split (falling back to close-tab when unsplit). Same-orientation splits insert siblings, cross-orientation splits nest groups, and an exited pane collapses its group; the pane that predates the first split keeps its live engine session. Rendering is tmux-flavored — a single divider line on shared edges (focus-accented), no frames, no padding. The split tree (`split-core.ts`) is deliberately content-agnostic: terminals are the first leaf type, not the only one.

## 0.7.64

### Patch Changes

- c7320aa: Terminal-in-the-middle lands (issue #16): the dormant embedded-terminal pane is revived — overflow clipping via opentui 0.4, the StyledText snapshot pushed through the renderable's content setter (the solid binding's content prop stringifies at runtime), user-visible strings moved to a new terminal.\* i18n namespace — and the KOBE_TUI workspace's center column now runs the task's real interactive engine CLI in an in-process Bun PTY. A dev:mock-terminal entry proves the PTY→xterm→render seam live.
- a21f68c: Fix: `kobe api fan-out --count N` now rejects an over-cap `N` before allocating instead of after. The `--count` branch built a `new Array(N)` of vendors and only then checked it against the fan-out cap, so a large `--count` (e.g. `--count 1000000000`) allocated a huge array — hanging or crashing the process with an out-of-memory error — before the "exceeds the cap" message it should have produced immediately. It now guards `N` against the cap up front, symmetric to the `--agents` spec path which already did so, so an over-cap request fails fast with the same clear error.
- ff36fdf: Fix the git numstat parser doubling a path separator when a rename adds or drops a directory level. Moving a file up out of a subdirectory (or down into one) makes git empty one side of its brace-compacted rename — `src/{sub => }/a.txt` — and the parser rejoined it as `src//a.txt`, so its +/- line counts no longer key-matched the `src/a.txt` the status row reports and the file-tree / sidebar change chips lost the counts for that file. The seam now collapses, so directory-level renames resolve to one canonical path across both git formats.
- 4967089: Chat history polling no longer re-parses the whole Claude transcript every tick: appends parse incrementally and already-seen messages keep stable identity, eliminating per-poll row churn in the history pane.
- 19d37ec: History pane now renders only the last 200 messages (with an "… N earlier messages" indicator) instead of mounting the entire transcript, fixing unbounded memory growth on long-running sessions.
- c4cbde6: Fixed a keybinding override where a dangling modifier chord (e.g. `ctrl+` or `cmd+alt+` in `keybindings.yaml`, with no key typed after the `+`) was silently bound to Ctrl+Plus instead of being rejected — kobe now reports a clear "no key after the modifiers" error, while the literal plus key (`ctrl++`, `+`) keeps working.
- 329698c: Upgrade @opentui/core + @opentui/solid 0.2.4 → 0.4.3 (React migration groundwork, issue #15). StyledText now flows through the `content` prop on the dormant embedded-terminal pane; DESIGN.md §8 records the framework re-decision (Solid → React, phased).
- 78bf2ad: PIVOT (issue #16): remove the native chat layer — the Solid and React chat panes and the AI SDK harness backend (`engine/ai-sdk/`, `@ai-sdk/*` + `ai` dependencies) are deleted. kobe is a wrapper around the real engine CLIs: the KOBE_TUI workspace's center column becomes the seam for the upcoming embedded-terminal tab (in-process PTY running `claude`/`codex` directly), replacing self-rendered streams. Engine registry drops the `nativeChat` capability; shared model/effort types stay.
- 16f0202: React port of the file tree pane (issue #15, G3): `src/tui-react/panes/filetree/` mirrors the Solid pane on the shared framework-free logic (`git.ts`, `rows.ts`, and the newly extracted `pane-core.ts` / `keys-core.ts`), with a `dev:mock-react-filetree` render proof against a throwaway git fixture. The Solid `FileTree.tsx` was also split back under the 500-line cap (pane-core / keys-core / row-view / header-view), behavior-preserving.
- 8662b40: React ports of the small shared dialogs + notifications (issue #15, G3 wave 2): NotificationsProvider (wired into the React pane host's provider nest), HelpDialog, ToastOverlay, and VersionSkewBanner under `src/tui-react/`, with `kobe help-page` selecting the React host behind `KOBE_REACT=1`. The pure notification state transforms and help-dialog category grouping moved to framework-free `src/tui/lib/{notify-state,help-groups}.ts` shared by both runtimes, and a `dev:mock-react-dialogs` workbench proves banner/toast/help render live.
- 9be9423: React ports of the task dialogs (issue #15, G3 wave 2): the full NewTaskDialog (Existing / New Repo / Adopt tabs, engine selector, saved/browse repo picker, branch picker, async clone) and RenameTaskDialog under `src/tui-react/component/`, driven by the shared framework-free `state.ts`/`clone.ts` helpers, with a `dev:mock-react-dialogs` live-render host.
- b45e192: React port of the Ops pane + preview window behind `KOBE_REACT=1` (issue #15, G3): `kobe ops` and `kobe ops --preview` now route to `src/tui-react/ops/` when the flag is set, mounting the already-ported React FileTree. The Solid host was split under the file-size cap, extracting the framework-free poll loops (`tui/ops/activity-monitor.ts`), shell actions + concrete tmux IO (`tui/ops/host-io.ts`), and the preview data/syntax mapping (`preview-core.ts`/`preview-syntax.ts`) shared verbatim by both hosts. `RemoteOrchestrator` gains a `transcriptActivityStore()` external-store twin of the `transcript.activity` signal for React consumers, plus a `dev:mock-react-ops` render-proof script.
- 95ea852: React port of the settings page behind KOBE_REACT=1 (issue #15, G3): `kobe settings` can boot the @opentui/react host with the full settings dialog (General / Engines / Accounts / Keybindings / Feedback / Dev), a React KVProvider backed by a framework-free kv-core with the same dirty-key-merge persistence as the Solid provider, and React ports of the confirm + rename dialogs. `bun run dev:mock-react-settings` renders the page against an isolated throwaway home.
- 5de39cf: G3.1 React migration pilot: `kobe history` can now render through the React pane host behind `KOBE_REACT=1`, sharing pure transcript formatting/windowing logic with the Solid pane and adding a React history mock smoke path.
- e6c8608: G3 groundwork (issue #15): React pane hosts get a real bootPaneHost — shared boot steps (crash handlers, keybindings.yaml overlay, user themes), persisted-prefs seeding before first paint, a themed crash boundary, and the shared exit-signal backstop. Live daemon ui-prefs/keybindings pushes now ride framework-free external-store twins in the client layer (solid-js signals are inert outside reactive-solid runtimes), consumed by React via subscribe/get; dev:mock-react boots through the real host path.
- d69c410: G2 of the React TUI migration (issue #15): the full infrastructure layer — theme, focus, dialog stack, key-bindings dispatch, and i18n — now has React counterparts under src/tui-react/, sharing framework-free cores (theme-core, i18n lookup, keymap-dispatch) with the Solid originals so the two cannot drift. The dev:mock-react pilot mounts the whole provider stack end-to-end.
- 29674d0: Add a G1 React runtime pilot beside the existing Solid TUI, including a standalone mock pane and dev script for issue #15.
- 5b129d5: React port of the sidebar pane behind the G3 migration track (issue #15): `src/tui-react/panes/sidebar/` mirrors the Solid Sidebar (views, `/`-search, project filter, move mode, cursor policy, hover tooltip, row cards) on the React runtime, with the framework-free view logic extracted to `src/tui/panes/sidebar/view-core.ts` and consumed by both renderers. New `dev:mock-react-sidebar` smoke host renders the port against shared synthetic task fixtures. No behavior change for the shipped Solid TUI.
- 2327f2d: Codex and Copilot history readers now share the append-aware transcript parse cache (previously Claude-only), so the ~2.5s history polls parse only newly appended lines and chat rows keep stable identity instead of re-rendering every tick.
- a08691e: Workspace terminal tabs (issue #16): the PTY-world chattab. The KOBE_TUI center column now carries a tab strip over the embedded terminal — ctrl+t opens a parallel engine session in the same worktree, ctrl+w closes (the last tab refuses), F2 renames through the real rename dialog, ctrl+]/[ cycle — reusing the canonical chattab binding ids and reserving those chords from PTY passthrough exactly as the tmux root key-table did. Per-task tab state survives task switches; each tab keys its own registry-backed PTY.
- b4efbd8: Embedded terminal input + chrome fixes (issue #16): the pane no longer draws its own border (the workspace layout wrapper owns the focus border — double borders gone), and key passthrough is now maximal — shift+tab (claude's plan-mode cycle), ctrl+hjkl, F1, ctrl+p and every other modifier combo reach the engine CLI. Kobe reserves only ctrl+q (escape hatch), the tab-management chords, and F5 while the terminal is focused; its other global chords stay reachable from every non-terminal pane.
- b731775: Paste reaches the embedded engine CLI (issue #16): opentui's parsed paste events forward to the PTY, and the Bun backend re-wraps them in bracketed-paste markers exactly when the embedded app negotiated DECSET 2004 — a multiline prompt pasted into claude lands as one paste instead of executing line by line.
- 76b327a: Embedded-PTY lifecycle closes its loop (issue #16): archiving or deleting a task now releases every engine PTY its terminal tabs own (registry gains releaseWhere for task-scoped teardown), and quitting the KOBE_TUI workspace releases all of them — no orphan engine processes either way.
- 144cac8: Embedded terminal hardening (issue #16, revival checklist #4/#5): a dead engine/shell now surfaces — every PTY backend gains an onExit notification (fires immediately for fast crashes) and the pane shows an "process exited — F5 restarts it" banner over the frozen snapshot instead of silently freezing. The registry, key-byte translation, and the newly extracted pure viewport math are pinned by unit tests.
- 3e54ab0: Drag-copy to the system clipboard survives an oh-my-tmux config rewrite. The workspace's copy-mode bindings (`copy-pipe-and-cancel pbcopy` on drag-release / `y` / Enter) could be silently rewritten by a user tmux.conf: oh-my-tmux's apply step, with its default `tmux_conf_copy_to_os_clipboard=false`, strips the clipboard command off every `copy-pipe*` binding, leaving a bare `copy-pipe-and-cancel` that never reached the OS clipboard — so drag-copy broke in panes without their own mouse handling (codex, plain shells) while Claude Code's built-in selection masked it. kobe now also sets tmux's `copy-command` option to the resolved clipboard tool; on tmux ≥ 3.2 a bare `copy-pipe` falls back to `copy-command`, so the copy lands in the system clipboard even after the rewrite.
- a8bbc7d: Engine preference now layers per-project last-active over a Settings-owned global default: picking an engine via Ctrl+Shift+T or in the new-task/quick-task dialogs remembers it for that project only, and no longer clobbers the default engine set in Settings → Engines. Existing `lastSelectedVendor` values carry over as the global default.

## 0.7.63

### Patch Changes

- 3476e0b: Ctrl+Q is now a no-op in full-window file preview / editor tabs. It used to run tasks-restore against the preview window and graft a Tasks rail into the full-width view; the restore now only fires in real workspace windows (engine pane present, rail missing).
- 00b46e6: test: pin the #205 orphaned-pane-process regression + add a `kobe doctor` resource snapshot

  - `test/behavior/pane-cleanup.test.ts` boots a real kobe session, runs `kobe kill-sessions` (the command `kobe reset`/`dev:sandbox:reset` also call), and asserts every pane's full process group is gone after the exit grace — not just the pane leader, since an engine CLI that ignores SIGHUP (real `claude` does) survives as an orphaned child of an already-dead leader. Verified against a temporary revert of the `termAllPaneGroups()` sweep: the test fails and catches the leaked pid, then passes again with the fix restored.
  - The shared behavior-test fake `claude` shim (`test/behavior/harness.ts`) now ignores SIGHUP like the real CLI does, so this and future behavior tests exercise the same "engine survives HUP" path production hits.
  - `kobe doctor` gains a `resources:` section (`src/cli/doctor-resources.ts`): kobe pane-process count + RSS grouped by command, so a future memory report comes with hard numbers instead of "eventually had to kill bun manually".

  No behavior change to the shipped CLI beyond the new `kobe doctor` section.

- 821dc48: fix: web memory leaks — SSE disconnect backstop + issue-snapshot cache sweep

  - SSE streams (daemon web transport + bridge) now tear down on the request's abort signal and on a failed heartbeat write, not only via `ReadableStream.cancel()`. A half-open disconnect (laptop sleep, dropped Wi-Fi, killed browser) could previously leave a phantom web client that kept `guiCount > 0` forever — pinning every collector (git status / transcript / PR polls) alive for a browser that was gone and preventing the daemon from ever lazily stopping.
  - The issue-snapshot mirrors (bridge `DaemonLink` and the SPA store) are now swept against the live task set on every `task.snapshot`, like the engine-state mirror beside them. Alias keys used to accumulate one per worktree path forever as tasks were created and deleted.
  - Split the `/api/settings` route block out of `web-server.ts` / `bridge.ts` into `web-settings.ts` / `bridge-settings.ts` (file-size cap; no behavior change).

- 4f48067: feat: standalone worktree management page (`x` from the Tasks pane sidebar)

  Lists every local saved project's git worktrees in one full-window tab, mirroring `kobe settings`'s shape: kobe-managed vs adopted, dirty state, whether the branch has reached `origin`, and how long ago the worktree was created. Deleting a worktree with uncommitted/untracked changes needs a second, more severe confirmation before force-deleting.

  New daemon RPCs `worktree.list` / `worktree.remove` back the page; `handlers.ts` was split by domain (`handlers-task.ts` / `handlers-worktree.ts`) to add them within the repo's file-size cap.

## 0.7.62

### Patch Changes

- 6ef6460: Fix: CLI path arguments now expand a leading `~` to your home directory. A quoted or tool-forwarded `~` reaches kobe verbatim (the shell only expands unquoted words), and it was being treated as an ordinary path segment — so `kobe add "~/repo"`, `kobe remove ~/repo`, `kobe adopt ~/repo`, `kobe repo set --init-script-file ~/s.sh ~/repo`, `kobe theme import ~/theme.json`, and `kobe api --repo ~/repo` all resolved to a bogus `<cwd>/~/repo` path that failed the downstream git/file checks with a confusing "not a git repository / file not found" error. These entry points now expand `~` / `~/…` (honouring `KOBE_HOME_DIR`) before resolving relative paths against the current directory, so `~`-relative paths work the same as absolute ones.
- 8ea5e57: Fix (tmux handover): the ctrl+h left-edge fallback now skips the CLI spawn entirely when the active pane already IS the Tasks rail (`@kobe_role=tasks` format gate) — the muscle-memory spam case spawned a background `kobe layout tasks-restore` per press (backgrounding shipped in 0.7.61; this removes the spawn itself). The real restore cases — rail hidden or crashed, where the left-edge pane is the engine/shell — still fire. Verified live on tmux 3.6.

## 0.7.61

### Patch Changes

- b2d6b5d: fix: persisted engine hooks prefer the packaged `kobe` bin over the dev entry path

  Global hook commands written into `~/.claude/settings.json` / `~/.codex/hooks.json` previously baked the absolute dev entry path (often inside a task worktree) when installed from a dev run — every hook fire then failed with "Module not found" once that worktree was removed. Hook installs now use `kobe` from PATH whenever a packaged bin exists, falling back to the dev invocation only when none is installed.

- 75ad039: Fix ctrl+h / ctrl+j pane focus on legacy terminals (macOS Terminal.app, #192): terminals without the kitty keyboard protocol send those chords as ambiguous C0 bytes (0x08 backspace / 0x0a linefeed), which never matched the focus bindings — they now alias back to their ctrl chords, while the real Backspace key (0x7f) keeps deleting. Also stop ctrl+h's left-edge tmux command from blocking the key queue (`run-shell -b`), so holding the chord can no longer freeze the client for seconds. `kobe doctor` now reports a terminal section (build/platform, TERM/TERM_PROGRAM, tmux nesting, live kitty-keyboard-protocol probe) and the bug-report issue template asks for its output.

## 0.7.60

### Patch Changes

- 973061b: Background panes now throttle their render loop: while a pane's tmux session
  has no attached client, the opentui targetFps drops to 2 (restored within ~3s
  of re-attach), cutting the remaining idle burn of invisible panes on top of
  the attach-gated pollers. Applied once in the shared pane-host boot, so every
  current and future pane host gets it.
- ddbe815: Fix the `**` globstar in `kobe adopt --glob` and the New Task → Adopt filter so it matches zero intervening directories: a pattern like `src/**/task.ts` now matches `src/task.ts` (worktree directly under the prefix) as well as `src/a/task.ts`, and a leading `**/name` matches `name` at the root. Previously a segment globstar compiled to a form that required at least one directory between the slashes, so it silently hid the zero-directory case and dropped worktrees you expected to see.
- c06d571: Background (detached) task sessions no longer burn CPU: the Tasks/Ops pane
  pollers — sidebar git-HEAD spawns, the Ops transcript-mtime sweep and
  capture-pane turn-status probe, the tasks.json backstop stat, and the live
  history tail — now check a shared, cached "is this session attached?" gate and
  skip their expensive work while nobody is looking. With ~10 sessions open this
  was ~25 pane processes at ~30% combined idle CPU; detached panes now cost one
  cached tmux probe per 3s. The first tick after re-attach resumes full cadence,
  and any probe failure fails open so a visible pane can never quiesce itself.

## 0.7.59

### Patch Changes

- 3a271e1: Add a per-task live preview mode: press `i` in the Tasks pane to toggle a task
  between the live engine and a read-only LIVE preview — the `kobe history`
  renderer tailing the transcript in the engine pane slot — for inspecting a task
  an agent is working in without driving it. The history preview pane is now
  live-refreshing (adaptive mtime poll shared with the Ops pane), so both the
  archived preview and this new mode follow the transcript instead of showing a
  one-shot snapshot.
- bc69596: Fix orphaned pane-process leak: killed tmux panes left their `kobe tasks` / `kobe ops` helpers (and engine CLIs) running forever. opentui's exit handler catches SIGHUP/SIGTERM but never exits the process, so every `respawn-pane -k` / session teardown reparented the old helper to launchd with a revoked tty — over a hundred zombies burning ~14 GB / 100%+ CPU in a busy week. Hosts now exit shortly after an exit signal (with a 5s grace so kill-own-session flows like the preview toggle still finish), and `killSession` / `kobe kill-sessions` / `kobe reset` SIGTERM each pane's process group before tmux's HUP so engine CLIs that swallow HUP are also reaped.
- 277fda0: The "Worktree location" setting (Settings → General) is now a preset cycle instead of a bare text field: enter switches between `default ~/.kobe/worktrees`, `next to project` (worktrees land beside each repo), and `custom` — mirroring the editor rows. Under the hood the sibling preset stores a new `$project_dir` token that expands to each task's project root when the worktree path is computed, and the custom path field accepts it too (e.g. `$project_dir/../scratch`) for hand-rolled per-project layouts. `..` segments are collapsed after expansion, the per-repo `<repo>-<hash>` subfolder is still appended so repos sharing a parent directory never collide, and the default root stays recognized for listing pre-existing tasks. New tasks only; existing worktrees stay where they are.

## 0.7.58

### Patch Changes

- b470ff4: Quick-fork composer accepts multimodal attachments. Paste an image or PDF file path (Finder copy / drag-drop — multi-file paste works) and it becomes an attachment chip instead of prompt text; press ctrl+v to pull a raw clipboard image (screenshot), which is saved under `~/.kobe/attachments/` and attached by path. Chips render as `images[0]` / `pdf[1]`, click a chip or press ctrl+x to remove, and on create the references are appended to the delivered prompt as `images[0]: /path` lines so the engine reads the files itself.
- 1f5af10: Fix a batch of TUI user-story logic bugs: Tasks-pane o/b/v now act on the
  cursor row (not the active task) and deleting/archiving a background task no
  longer steals focus; Shift+P (pin) is wired and Shift+M help matches its
  reorder behavior; the file tree keeps its cursor across fs-watch refreshes and
  reuses the tab cache; new-task base-ref prefers an exact branch match; git
  clone no longer hangs on credential prompts; the git-HEAD poller stops caching
  an empty branch label; error toasts always surface; plus untracked line counts,
  typechange rows, surface-window Ctrl+h/tab-switch guards, CJK legend width, and
  the update banner version.

## 0.7.57

### Patch Changes

- 3476c25: Add a global "Worktree location" setting (Settings → General) to configure where new task worktrees are created. By default kobe stores local worktrees under `~/.kobe/worktrees/<repo>-<hash>/<slug>`; the new free-text field re-roots that base directory to any path you choose (with `~` and relative-path expansion), while keeping the per-repo `<repo>-<hash>` subfolder so worktrees from different repos never collide. The override is read fresh by the daemon on every task create — no restart needed — and applies to new tasks only: existing worktrees keep their recorded path and the old default root stays recognized for listing and slug allocation. Remote (SSH) projects are unaffected; their worktrees still live under the project's remote `basePath`.

## 0.7.56

### Patch Changes

- a50acf9: Fix (TUI beta): closing the archived-history preview no longer spawns a live engine on the archived task. With `experimental.archivedHistoryPreview` on, opening an archived task shows a read-only `kobe history` pane in the engine slot — but pressing its "q close" key dropped to a bare shell and, on exit, routed through the engine pane's `engine-tab-exit` cleanup, which relaunches a live engine when it's the task's only tab. That re-ran a real `claude`/`codex` on an archived task (in a fallback dir when the worktree was already removed) — exactly what the preview is built to avoid. The preview is now a persistent read-only pane (like the Ops pane): it ignores SIGINT and re-launches itself instead of falling through to a shell or an engine, and the misleading self-close key is removed — leave the preview via the Tasks rail or Ctrl+Q like any other pane.

## 0.7.55

### Patch Changes

- 8ce95b4: Beta (web): preview an archived task's read-only engine history. When a task is archived (e.g. after its git worktree is removed), its transcript still lives in the engine's vendor store keyed by the worktree path, so the existing `ChatTranscript` viewer can render it with no live engine. Behind a default-off experimental gate — Settings → Experimental → "Archived history preview" — which makes archived rows in the rail clickable, opening the transcript in a read-only drawer. Claude + Codex (and Copilot) are covered via the neutral `EngineHistoryReader`; no vendor formats are touched in the UI.
- 91f70b1: Beta (TUI): preview an archived task's engine history in the engine pane. With the `experimental.archivedHistoryPreview` gate on (Settings → Dev → Experimental, shared with the web dashboard), opening an archived task launches a read-only `kobe history` pane — a session selector + scrollable transcript — into the engine pane slot instead of relaunching the engine. It reads the vendor transcript store (claude/codex/copilot) by the recorded worktree path, so it works even after `git worktree remove`; the worktree is never re-materialized, no init script or status/dispatcher protocols run, and panes fall back to the repo (or home) when the worktree dir is gone.

## 0.7.54

### Patch Changes

- d2b2cec: Auto-archive a task when its git worktree is removed. The global `PostToolUse` (Bash) hook that adopts a task on `git worktree add` now also detects `git worktree remove <path>` and archives the task pinned to that exact worktree — the symmetric complement to creation-time adopt. Archiving (not deleting) keeps the task's branch and history; an untracked worktree or a main/repo-root path is left untouched.

## 0.7.53

### Patch Changes

- c91144e: fix: stop `invalid option: @kobe_zen` tmux banner on session-option polls

  `getSessionOption` ran `show-options -v` without `-q`, so reading an unset
  session-scoped user option (`@kobe_zen`, `@kobe_worktree`, …) made tmux error
  with `invalid option: …` and the capturing wrapper surfaced it as a banner on
  every zen/task-enter poll. Added the load-bearing `-q` (matching
  `getServerOption`) so unset options resolve to `""` with exit 0 instead.

- c91144e: fix: Tasks pane no longer strands a stale cursor on a jumped-to project

  In a task-bound Tasks pane the selection is pinned to its own task (`onSelect`
  no-ops), but clicking/Entering another project moved the pane's cursor to that
  row before jumping the client away. Because the cursor-sync effect only re-runs
  when `selectedId` changes — and a pinned pane's never does — the cursor stayed
  stranded on the jumped-to row. Switching back then showed that stale cursor as a
  second selection while the pinned project was the one actually open ("top-left
  selection unreasonable" when clicking project A then B then back). Jump-away now
  snaps the cursor back to the pinned row via a new `pinnedSelection` Sidebar prop.

- c91144e: fix: a superseded project switch no longer steals the active task

  Hardening alongside the cursor-stranding fix: when several project switches
  overlap, a slow `enterTask` (cold session create) used to call `setActiveTask`
  only after its session was built, so an earlier, slower switch could finish last
  and clobber the shared active task. `enterTask` now takes an `isCurrent` guard
  and the Tasks pane stamps each switch with a monotonic token, so a superseded
  switch skips the disruptive `setActiveTask` + `switch-client` — the last switch
  wins.

## 0.7.52

### Patch Changes

- adbf67f: feat: exiting a task's engine now tidies up its chat tab instead of leaving a dead shell. When the engine process exits and you then `exit` the fallback shell, kobe closes that chat tab — and if it was the task's only tab, it opens a fresh engine tab in its place so the task session never goes empty. The other workspace terminals (Ops / the bottom shell) are unchanged: exiting one of those just heals the layout. Together with the layout-heal and capture-poison fixes this resolves the "Exit the terminal layout error" report (#179).
- adbf67f: fix: the "Engine exited" banner no longer tells you to "press R to relaunch" — a key that was never wired. When an engine pane exits non-zero it drops to a fallback shell and prints the exit code; the banner promised an `R` relaunch shortcut that does not exist (the terminal pane forwards bare keys straight to the shell, so `R` just typed an `R`). The banner now points only at Settings → Engines to fix the launch command, which is the action that actually exists.
- adbf67f: fix: a fast Ctrl+C right after a task's engine pane appears no longer closes the pane mid-init. The engine ran inside a `sh -c` wrapper, so a SIGINT during the per-repo init script or the engine's startup window hit the whole process group and killed the wrapper before it reached the keep-alive fallback shell — tmux then closed the pane (the center pane "vanished"). The engine wrapper now traps SIGINT (`trap ':' INT`) so only the engine child receives Ctrl+C (it resets to the default handler and stays interruptible) while the wrapper survives and always lands on the fallback terminal. A pane now closes only on a deliberate `exit`.
- adbf67f: fix: a task's workspace layout now re-pins itself after you exit a terminal pane. Closing a workspace-split terminal (typing `exit`) hands its cells to a neighbouring pane, which knocks the fixed-width Tasks rail and the right column off their pinned geometry — the same disorder a terminal resize causes, except `window-resized` never fires because the window size is unchanged. Until now the only recovery was switching to another task and back (which heals on switch-in), so the currently-focused task stayed visually broken until you dragged the panes back yourself. kobe now heals the layout on tmux's `pane-exited` hook, re-pinning the rail and right column to the shared globals the moment a pane closes.
- adbf67f: fix: closing a task's bottom-right terminal with `exit` no longer squashes the terminal pane across every task. The shell pane has no keepAlive, so typing `exit` really kills it and the Ops pane grows to fill the right column. The layout-capture path (both the live `window-layout-changed` drag gate and the switch-away capture) then read that transient ~100% Ops height and wrote it to the GLOBAL Ops-height option, so every later layout heal re-applied the squashed height to all tasks until a manual re-drag. Capture now bails when the `shell` role is absent (without the hidden-by-toggle flag), so a closed terminal can't poison the saved geometry.
- 1a1fad8: fix: the web diff viewer now shows the patch for files whose names have non-ASCII characters, spaces, or control characters. Git C-quotes those paths in `git diff` output (octal byte escapes like `"b/\303\274.txt"`) and appends a disambiguation tab to spaced names (`+++ b/a b.txt\t`), but the per-file patch splitter keyed on the raw marker text and used a weaker local unquoter, so the patch never matched the NUL-delimited porcelain path and the file rendered as changed with an empty diff. Path resolution now flows through the shared rigorous git-path unquoter and strips the disambiguation tab, so unicode, spaced, and special-char filenames join their hunks correctly.

## 0.7.51

### Patch Changes

- ab0828d: Own ellipsis truncation behind one code-point-safe module. Task titles, branch chips, and path tails previously each re-implemented their own slice-and-ellipsis logic with three different `max <= 0` behaviours and inconsistent surrogate-pair handling — the sidebar's path truncator could bisect an emoji into a `�`. They now all funnel through `truncateEnd` (keep prefix) / `truncateStart` (keep tail) in `tui/lib/truncate.ts`, so the boundary rule is one place and every label is surrogate-safe.

## 0.7.50

### Patch Changes

- be37c6b: Internal: the sidebar's "where should the cursor go when the selection or the list changes" rules (follow selection, clamp a dangling cursor when the selected task vanished from another surface, snap an unset cursor) now live in one pure, unit-tested function instead of inline branches in the render effect. No behavior change — this is the area three recent selection/highlight fixes came from, now regression-netted.
- eeb660d: Entering a task now goes through one Handover owner, so every path fits the window before switching and inherits global zen. Previously the Tasks-pane switch, the new-task/quick-task jump, and the delete-path switch-away each re-implemented "ensure session → fit → switch" and had drifted — the page-jump didn't follow global zen and the delete switch skipped the fit. Tasks opened from the new-task/quick-task pages now collapse to zen when it's on, and no enter path can land on an unfitted (reflowing) window.
- 179cee2: Internal: the workspace's intended layout geometry (Tasks-rail width + right-column split) now resolves through one owner instead of being re-parsed/re-clamped/re-defaulted at every reader. No behavior change — the pure resolver is unit-tested, so the rail/right-column sizing is a regression-netted single source.
- 26c056b: Internal: persisted boolean flags (zen on/off, zen keep-tasks, the experimental auto-status / dispatcher / remote-projects switches) now read through one `getPersistedBool(key, default)` owner instead of each inlining `x === true` / `x !== false`, where the idiom silently encoded the default and was easy to get backwards. No behavior change — the default-handling and the "don't coerce a non-boolean value" rule are now unit-tested in one place.
- 98c1e7a: Internal: the `ui-prefs` wire decode (theme guard + the backward-compat defaults that let an older daemon's payload omit newer fields without resetting them) now lives in one pure, unit-tested `decodeUiPrefsPayload` instead of inline in the client's channel switch. No behavior change — the version-negotiation rules (notably "absent locale → leave the language alone", not reset to English) are now regression-netted.

## 0.7.49

### Patch Changes

- 535756b: Clicking a row in the Tasks sidebar now always moves the cursor to it. After navigating away with j/k inside a task's own pane, a mouse click (even on the pane's own task) couldn't bring the selection pointer back, because the click relied on `onSelect`, which a task-bound pane no-ops to keep its highlight pinned. The click now moves the cursor directly, decoupled from selection.

## 0.7.48

### Patch Changes

- bf82cc8: Opening a task whose tmux session wasn't running no longer lands with all panes squished to near-even widths. The session was created at the Tasks-pane host's narrow pty width and its panes were split at that size, so growing the window to the real terminal later only redistributed proportionally — the fixed-width sidebar rail ballooned and the layout went uniform. The window is now fitted to the real client size before the panes are split, so a cold-opened task shows the intended proportions (narrow rail, wide chat, right column) from the first frame.
- cc42ccb: Deleting the active task no longer flashes a window resize. The delete path switches the client to the next task (or kobe-home) before killing the old session, but unlike the normal switch/enter paths it skipped the pre-switch fit, so it landed on a session still sized to another client and reflowed. It now fits + heals the target first, matching `switchTo`/`jumpToTask`.
- 342b862: A project's main chat now follows your configured default engine instead of always opening on Claude. The main task's engine was frozen to "claude" the moment the project was first added and never re-read the default, so setting the default to codex had no effect on existing projects. Worse, on a daemon restart the stale "claude" vendor would win the vendor-drift check and respawn a healthy running codex session back to Claude, wiping the open chat tabs. The launcher now reconciles before starting the session: it adopts the vendor a live session is actually running (so a restart never clobbers it), and falls back to the global default when no session is up (so cold-opening an existing project honors the default). Newly added projects also create their main task on the default engine.

## 0.7.47

### Patch Changes

- 0f574d2: The `☯ ZEN` badge in the Tasks rail is now clickable — click it to exit zen mode, the mouse counterpart to the `prefix`+space chord. Since zen is global, exiting from the badge turns it off for every project.
- 9c1ac3e: Zen mode is now global across every project. Each task is its own tmux session, so toggling zen previously only collapsed the session you were in; switching to another project lost it. Zen on/off is now a persisted intent that every project's session reconciles to when you enter or attach it — turn it on once and all projects open focused.
- 41ac154: Tasks pane: a task-bound pane now keeps its sidebar highlight on its own task instead of following the shared active-task focus. Jumping to a sibling project (click/Enter) no longer leaves the backgrounded pane highlighting that sibling while its chat still shows its own task — only the navigational home pane mirrors shared focus now.

## 0.7.46

### Patch Changes

- 2e96b24: fix: stop dropping multi-line paste and full-width-space prompts in input fields

  The feedback "description" field used an opentui `<input>`, which strips
  newlines inside the native widget on paste — so a multi-line pasted bug report
  was silently collapsed to one line. It is now a `<textarea>` that preserves
  paragraph structure (enter inserts a newline; tab moves to Send), while the
  single-line fields (title, branch, repo, prompt) keep stripping newlines.

  The quick-task prompt and rename-task title guards also accepted a prompt/title
  made only of a full-width space `　` (U+3000), which `String.prototype.trim()`
  does not strip — submitting an empty-looking task. Both now reject any value
  with no non-whitespace character via a shared `isBlankText` predicate.

- 73b0788: Pane-aware mouse drag now copies to the system clipboard. The tmux workspace enables `set-clipboard on` and binds copy-mode finish actions (drag-release plus `y`/Enter) to `copy-pipe-and-cancel` via the platform clipboard tool (pbcopy / wl-copy / xclip / xsel), so a normal left-drag selection reaches the OS clipboard without falling back to Option+drag (which bled across panes). Falls back to OSC 52 when no local clipboard tool is found.

## 0.7.45

### Patch Changes

- 8cebff3: fix: stop the activity watchdog from idling a still-running task mid-turn

  The daemon's engine-activity badge armed a fixed ~10min lapse timer for any non-idle state and idled the task when it fired. But a long single agent turn emits only `turn-start` … `Stop` over many minutes with no hook events in between, so the timer fired mid-turn and wrongly dropped a working agent's badge to idle. The watchdog now probes the engine's transcript mtime before lapsing: a write within the trailing staleness window means the turn is alive (re-arm a heartbeat instead of idling), while a genuinely silent engine (missed Stop / hung process) still lapses. The probe is filesystem-only and best-effort — failure falls back to the old lapse behavior, never crashing the daemon.

- c4037a8: refactor: back the daemon file-watch trigger with chokidar

  Replace the hand-rolled `node:fs.watch` + manual polling safety-net in the
  shared file-watch trigger with chokidar, which handles the cross-platform
  fs-event edge cases (macOS rename/inode churn, rapid bursts, atomic saves)
  the bespoke poll was compensating for. The exported signature, basename
  filtering, debounce, and `stop()` teardown are unchanged, so the ui-prefs and
  keybindings watchers are untouched.

- 184511c: fix: pane heal tolerates a pane that vanished mid-heal

  The workspace/version heal reads a pane snapshot, then runs one batched `respawn-pane … ; resize-pane …` tmux sequence against those ids. tmux halts a `cmd ; cmd …` sequence on the first failure, so a pane closed (tab close / task delete) between the snapshot and execution made its `respawn-pane -t <gone>` error and silently abort the heal of every later pane that tick. The heal now re-lists panes immediately before the batch and drops commands for any pane that no longer exists, so one vanished pane can no longer cancel the heal of the others. Only paid when the heal has work to do — a healthy switch (no commands) keeps its exact behavior and spawn count.

- 5ef48a3: perf: daemon-collect transcript activity instead of polling it per Ops pane

  Every `kobe ops` pane used to stat the engine transcript dir (the `● new` badge) and re-parse the newest session JSONL (the ChatTab "done" chip) on its own timers — W ChatTabs × K transcripts of duplicated filesystem churn at rest. The daemon now runs one `transcript.activity` collector for the shareable filesystem half (newest mtime + the engine-owned completion marker) and fans it out; the per-window `tmux capture-pane` quiescence check and `@kobe_tab_state` write stay in-process. Old/stale daemons without the channel fall back to the pane's local polling verbatim, and the badge/done-chip behavior is unchanged.

- baf710a: fix: make the interrupted-prompt rescue writer append-only (no transcript clobber)

  `appendInterruptedUserPrompt` ran during `engine.stop`, while the just-SIGTERM'd claude process may still be flushing buffered records to the same session JSONL. The merge path read the whole file into memory, spliced, and `writeFile`-rewrote it — truncating any record flushed after the read snapshot (a half-written assistant reply or tool result), silently losing data. It now only ever `appendFile`s: a coalesced un-replied user turn is written as a same-parent sibling that supersedes the prior turn (claude `--resume` follows the newest leaf, so the model still sees one user turn), and concurrent flushes are preserved no matter when they land.

- 11033f1: fix: harden the kobe-web dashboard and PTY sidecar

  The browser dashboard now self-heals after a daemon restart: the SSE client nulls out a CLOSED EventSource (so the next subscribe re-opens instead of wedging on "connecting…") and drives a bounded backoff reconnect, and every `snapshot`/`channel` frame is shape-validated before it touches the store so a malformed/partial frame is dropped+logged instead of crashing on the next `.map`/`.find`. The node-pty sidecar caps concurrent sessions (evicting the oldest unwatched tab, rejecting when all are in active use) and applies PTY→WebSocket backpressure (pausing a flooding pty once any socket saturates, resuming once every socket drains) so a runaway terminal can't grow node memory unbounded.

## 0.7.44

### Patch Changes

- 62dce57: fix: move `node-pty` to runtime dependencies so `kobe web` works on global installs

  The `kobe web` PTY sidecar (`dist/web-ui/pty-server.mjs`) imports `node-pty` at
  runtime, but it was declared under `devDependencies`, so a published `npm i -g
@sma1lboy/kobe` never installed it and `kobe web` crashed with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'node-pty'`. Moved it to
  `dependencies`.

## 0.7.43

### Patch Changes

- 472bb27: Apply write backpressure on the daemon's per-client socket fan-out. Each subscribed client now writes through a bounded `ClientWriter` that pauses when `socket.write()` reports a full send buffer and resumes on `'drain'`, so a slow/stalled client no longer makes Node queue unbounded heap on the long-lived daemon (a prior OOM risk under a fast event stream). The queue sheds the oldest droppable channel frames past a high-water mark while never dropping `daemon.stopping` lifecycle or RPC response frames, never reordering a client's stream, and never letting one slow client stall the fan-out for healthy ones.
- c526615: Consolidate `git status --porcelain` / `git diff --numstat` parsing into one rigorous shared module (`src/lib/git-parsers.ts`) with correct C-string unquoting. The file-tree Changes tab and the sidebar's `+N −M` chip previously parsed the same two formats with different rigor and neither unquoted paths, so files whose names contain spaces, tabs, newlines, quotes, or non-ASCII bytes rendered with the wrong (still-escaped) path and renamed/modified spaced files silently lost their +/− line counts (porcelain quotes a spaced path, numstat does not, so the two never key-matched on join). Both panes now derive from the shared parser — preserving each one's IO contract (file tree throws, sidebar soft-fails to zero) — and the file-tree Changes tab now falls back to the staged diff on an initial commit / unborn branch so changed files still show real counts instead of blanks.
- fa52fc9: Harden engine transcript/credential file reads against OOM/hang. The Claude/Codex/Copilot history readers and `account-detect` now stat-bound a file before slurping it (oversize → an empty/"not detected" result instead of loading a multi-GB file into a string) and cap each JSONL line's length before `JSON.parse`, skipping a pathological mega-line exactly like a malformed one. The Codex rollout date-tree traversal also caps how many paths it collects, consistent with the existing `MAX_*` scan caps, and notes once when truncated so a corrupt `~/.codex/sessions` can't grow an unbounded array. Every bound degrades, never throws into auto-title/Ops/history, and never logs file contents.
- 711134c: Snapshot the binding stack at keymap-dispatch entry so a handler that synchronously mounts/unmounts components (mutating the live stack via Solid mount/cleanup) can't skip or double-visit the in-flight scan. Precedence is unchanged — the same top-down LIFO order is searched and the same binding wins. Also adds a re-entrancy guard that drops a nested dispatch triggered from inside a handler, so a single keypress resolves to at most one binding (no behavior change for the normal, non-re-entrant case).
- c8b7fbd: Log dropped/malformed daemon events instead of silently swallowing them. When the daemon publishes a bad frame, `RemoteOrchestrator.handleEvent` now records one tagged `client.log` line at each shape/type-guard drop site (task.snapshot, engine-state, task.jobs, worktree.changes, ui-prefs, keybindings) before discarding the event, so a frozen-task-list incident is diagnosable. Control flow is unchanged — malformed frames are still dropped, never acted on.
- 9d5919a: Distinguish a `gh`/transport failure from a genuine "no PR yet" in the daemon's PR-status poller. A non-success `gh pr view` is now classified into a typed error (`missing-binary` / `auth` / `timeout` / `network` / `parse` / `no-remote`) versus a real `empty` result, instead of both collapsing to "no PR": an error keeps the last-known chip (a transient blip never clobbers a good status) and logs _why_ it's stale so it's diagnosable. Consecutive transport failures now back off exponentially (capped) so a persistently broken `gh` (e.g. not installed) stops re-spawning every tick, a deterministic "no GitHub remote" settles to a long idle cadence, and every scheduled poll is jittered so N tasks coming due together (after a network reconnect) no longer poll in lockstep. Best-effort and non-throwing throughout — a PR-status failure still never crashes the daemon or blocks other collectors.
- f3b2357: Bound a repo's `.kobe/init.sh` with a watchdog so a hanging init can't wedge task entry. The init snippet woven before the engine now runs in a backgrounded subshell with stdin from `/dev/null` (an interactive `read`/password prompt gets EOF instead of blocking forever) under a POSIX `sleep N && kill` watchdog — no GNU `timeout(1)`, which macOS lacks. On timeout (default 120s, overridable via `KOBE_REPO_INIT_TIMEOUT_SECONDS`) the init subtree is TERM-then-KILLed and the launch continues to the engine with a legible banner; a failed or timed-out init never blocks the task and isn't marked done, so it retries next launch. The "same shell so `export`s reach the engine" contract is preserved across the subshell via an `export -p` env round-trip.
- 0f69efc: Validate the persisted `lastSelectedVendor` preference before it drives engine selection. A corrupt or typo'd value in `state.json` previously cast straight to a `VendorId` and flowed into the new-task / quick-task / settings default-engine pickers as a bogus id that silently failed to launch. The four read sites now run it through a new `resolvePersistedVendor` helper that accepts only the three built-ins plus the user's registered custom engines and otherwise falls back to `claude`.
- 84aa2f9: Only advance the session's `@kobe_vendor` tmux tag after every window's engine pane respawns cleanly during a vendor switch. Previously a partial failure (some window's `respawn-pane` erroring) still moved the tag to the new vendor, so the failed window kept running the old engine while its Ops pane polled the wrong vendor's transcript and did wrong turn detection. The in-place respawn now reports an aggregate success/failure; on failure the prior tag is left untouched (the next `ensureSession` retries) instead of falsely claiming the switch — and the session is never killed+rebuilt, so sibling chat tabs survive.

## 0.7.42

### Patch Changes

- f677859: Wire Codex's hook mechanism for engine activity, mirroring Claude. Codex sessions now report `session-start` / `turn-start` / `turn-complete` and auto-adopt freshly-created worktrees via `~/.codex/hooks.json` (same settings-file shape as Claude). The read/merge/write I/O and install/remove methods are consolidated into a shared `JsonHookAdapter` base class, so each engine adapter is just its event→verb table plus settings path. `turn-failed` / `session-end` / `awaiting-input` stay on the polling fallback (Codex has no matching observer events); Codex's per-engine hook trust prompt still applies.
- b638bfe: `kobe export --format table` now aligns its columns by terminal display width instead of UTF-16 code-unit length, so a wide-glyph cell no longer shoves every column to its right out of line. A CJK task title (the common case — kobe is Simplified-Chinese-default), a fullwidth or emoji character all count as two cells, combining marks and variation selectors as zero, and astral characters (CJK Extension B, emoji) count once rather than as their two surrogate units; the table stays aligned for any mix of scripts.
- bf99f5c: Fix Ctrl+[ in the New Task dialog so it steps to the previous sub-tab instead of repeating Ctrl+]'s forward jump — with the three Existing / New Repo / Adopt tabs both chords were cycling the same direction, leaving no keyboard chord to move back.
- 6626b3a: File pane Changes tab now shows +/- line counts for renamed files. The pane merges `git diff --numstat` counts onto each `git status` row by path, but the numstat parser looked for porcelain's `->` rename separator — whereas `git diff --numstat` actually renders renames with `=>` and brace-compacts the unchanged path segments (e.g. `src/{old.txt => new.txt}` or `{dir => other}/x.txt`). So a renamed file's stats keyed off the raw brace text, never matched its post-rename path, and the row rendered with blank counts. The parser now resolves the numstat field to the same canonical new path the porcelain `R` row reports, so renamed files carry their line counts like every other change.
- b7ea975: Add `kobe completions bash|zsh|fish` to generate shell completion scripts for the three major shells; scripts complete top-level subcommands and print to stdout for redirection into the appropriate shell completion file.
- bedfb76: Make `tasks.json` writes safe across concurrent kobe processes. The TUI, daemon and CLI all write the same task manifest; previously each save serialized its whole in-memory snapshot, so two processes racing (e.g. a `kobe api` create while the TUI was open) could silently clobber each other — one process's brand-new task vanished on the next save. Writes now take a short-lived PID lockfile (the previously-dead `lockfile.ts`) for mutual exclusion and do a read-merge-write: each save re-reads the on-disk manifest fresh and merges only this process's own changes on top, so concurrent creates both survive, a peer's deletion is not resurrected, and our own deletion is not undone by a stale copy.
- b8ba6aa: Make pane hosts crash-resilient: a single rejected fire-and-forget promise or a render-tree throw no longer drops a `kobe <pane>` process to a raw shell. Each pane now installs a process-level `unhandledRejection`/`uncaughtException` net that logs to `client.log` instead of exiting (mirroring the daemon), and the host view tree is wrapped in a Solid `ErrorBoundary` that paints a themed "this pane crashed — reload" placeholder.
- 645b25f: Tie the TUI's loose timers and async fetches to their component lifecycle so nothing fires after unmount. Toast auto-dismiss (`NotificationsProvider`) and the dialog's deferred refocus were fire-and-forget `setTimeout`s that could run against a torn-down signal or a destroyed renderable; both now go through a new owner-scoped `createManagedTimeouts` helper that clears any pending timer on cleanup. The file-tree pane's tab/refresh and worktree-change refetches now carry an `AbortController` that is aborted on the next run or on cleanup, threaded through `runWorktreeGit` so a rapid tab-switch or repeated refresh actually kills the in-flight `git` subprocess instead of stacking overlapping reads.
- d54a1d2: Make worktree creation idempotent and self-cleaning on partial failure. If recording the new worktree's path fails (or the task is deleted mid-create), `ensureWorktree` now rolls back the just-created worktree and frees its slug, so a retry no longer collides with orphaned on-disk debris. A worktree created moments before a concurrent delete no longer throws a spurious "task not found". Adopting multiple worktrees now reports a real N/M summary instead of hiding the ones that succeeded behind a generic error.

## 0.7.41

### Patch Changes

- a6198ca: `kobe add <path>` now rejects a path that isn't a local git repository instead of saving it verbatim. Before this, `kobe add ,` (where `,` resolves to a non-existent directory) silently stored the garbage path as a saved project — which then surfaced as a synthetic main row in the PROJECTS sidebar that couldn't be deleted (`deleteTask` refuses main rows, so it failed with a confusing error). Add validates with `git rev-parse --is-inside-work-tree` and exits non-zero with a clear message; an already-saved garbage entry can still be cleared with `kobe remove`.
- 1f69472: Deleting a project (the `kind: "main"` row) now works from the TUI, and removing a project no longer leaves an orphan row behind. Pressing `d` on a project row used to route to `deleteTask`, which refuses main rows — so it just failed with a confusing error (e.g. `connect ENOENT …`). It now runs a non-destructive "forget project" flow: un-save the repo and drop its synthetic main row, while the repo's files, branches, worktrees, and any real tasks under it stay on disk. `kobe remove` got the same fix end-to-end — previously it dropped the saved-repos entry but left the main task in the daemon-owned index, so the project kept showing up. Both paths now go through a new `forgetProject` orchestrator method (and `project.forget` RPC), matching by the canonical git-toplevel key so a subdirectory or differently-realpathed input still hits the stored entry.

## 0.7.40

### Patch Changes

- 649a2b7: Add `kobe remove [path]` — the inverse of `kobe add`. It forgets a saved project (drops it from the new-task picker) without touching anything on disk: the repo's files, worktrees, branches and tasks all stay. Matching is forgiving — pass a relative path, a subdirectory, or the exact stored entry (so a stray/garbage entry or a remote `ssh://user@host` key is removable verbatim); run with no match to print the current saved projects so you can copy the exact one. Removing a remote project also drops its stored connection config so no orphan `remoteRepos` entry is left behind. Until now there was no way — TUI or CLI — to remove a saved project.

## 0.7.39

### Patch Changes

- 7e6998f: The task sidebar's project filter now rides on the **PROJECTS** section header instead of a separate line above it. The active filter (`all` or a project name) and its matching task count sit inline on the same row — `PROJECTS  all ──── 2 tasks` — and the whole header stays clickable to cycle the filter, saving a row of vertical space in the rail.

## 0.7.38

### Patch Changes

- 82fad6c: kobe now speaks more than English. A small reactive i18n framework (`src/tui/i18n`) ships with an English source-of-truth catalog and a full Simplified-Chinese (简体中文) translation, and the Settings dialog is the first surface routed entirely through it — every label, hint, toggle and the Feedback form now translate. A new **Language** picker under Settings → General switches between English and 中文; the choice applies live in-process and persists to `state.json` (`locale`), so other panes pick it up on their next boot, mirroring how the theme is applied. English stays the default. Locale parity (no missing/extra keys, no dropped `{placeholders}`) is gated in CI and by `bun run check-i18n`.

## 0.7.37

### Patch Changes

- 2bd16eb: File pane Changes tab no longer shows bare directories. `git status --porcelain` collapses a fully-untracked directory into a single `dir/` row, which rendered as a directory with no +/- stats and nothing to open. The pane now runs `git status` with `--untracked-files=all`, expanding untracked directories into their individual files (matching the All tab's `git ls-files --others` enumeration and respecting `.gitignore` the same way); a trailing-slash row is also skipped defensively so a directory can never appear as a change entry.
- be61ac9: File pane no longer mangles non-ASCII filenames when the path is truncated on a narrow pane. `truncatePathTail` counted UTF-16 code units and sliced mid-character, so a path tail ending in an emoji or other astral character (e.g. `…my-🎉-feature.ts`) could split a surrogate pair and render a `�` replacement glyph. It now slices by code point — matching `orchestrator/title.ts` — so characters stay intact. The helper moved to the pure `filetree/rows.ts` module and gained unit tests.
- 51dc15f: The Tasks sidebar now shows live PR check status (KOB-10). A daemon poller runs `gh pr view` for each task's branch (GitHub only) and writes the result onto the task, so the sidebar row gains a right-stuck chip — ✓ passing / ✗ failing / • pending — that updates as CI moves, without leaving the TUI. Status is persisted on the task (it rides the existing snapshot push, so every Tasks pane and the web board see it, and it survives a daemon restart) and only ever written from a successful `gh` call, so a missing/unauthed `gh` or a transient network blip never clears a known chip. The poller backs off for branches with no PR and for merged/closed PRs, and pauses entirely when no pane is attached.
- e659c43: Workspace now follows the terminal when it grows. The pre-attach/pre-switch `resize-window` that fits a task window to the entering client flips tmux's `window-size` to `manual`, so a live terminal resize from small to large no longer auto-grew the window — `window-resized` only fires when the window actually resizes, which a manual-pinned window never does on growth, leaving the UI letterboxed at the old small size until a task switch or reopen. A new `client-resized` hook (`kobe resync-window`) re-pins the active window to the resized client's size and re-heals the rail on every terminal size change, regardless of the manual pin, so the outer frame tracks the terminal while only the inner Tasks rail stays fixed-width. The hook coalesces a resize drag's event burst to one re-pin, and batches the window resize and the rail re-pin into a single tmux command sequence so the layout repaints once — the terminal grows without flashing through a momentarily distorted (proportionally-reflowed) frame.
- a719c1c: Prompts delivered into a tmux engine pane (the repo `init-prompt.md` first message, `kobe api send`, and quick-task delivery) no longer occasionally sit unsent in the composer. `pasteAndSubmit` wrote the bracketed paste and the submit Enter back-to-back, so they could coalesce into one tty read and the engine treated the carriage return as paste content instead of a submit — the same failure the web composer and PTY sidecar already fixed by deferring the Enter ~150ms (CHANGELOG 8f6dd64). The tmux delivery path now applies the same split.
- 5a57aca: Add a Zen mode that collapses a ChatTab to the engine pane. Trigger it from the `zen` chip above the file list (left of `create PR`) or with tmux `prefix`+space; it hides the file/Ops and terminal panes, and the Tasks rail too unless the new Settings → General → "Keep Tasks pane in zen mode" toggle is on (default on, so the kept Tasks rail stays reachable to leave zen). A second press restores exactly the panes zen hid, leaving any pane you'd already collapsed untouched. While zen is active, the kept Tasks pane shows a `☯ ZEN` badge at its bottom-left as a mode reminder.

## 0.7.36

### Patch Changes

- 136417f: Add `kobe export` to dump the task list to stdout without a running daemon. It reads `~/.kobe/tasks.json` in process and prints JSON (default), CSV (`--csv`), or an aligned table (`--format table`), so you can pipe tasks into `jq`, open them in a spreadsheet, or glance at them in the terminal — complementing `kobe api list`, which is JSON-only and requires the daemon.
- e5e7eee: Fix tasks silently reverting to Claude on restart. The task index loader validated the persisted engine against a stale `claude | codex` check, so a Copilot task — or any task using a user-registered custom engine — quietly downgraded back to Claude every time the daemon reloaded `tasks.json`. Loading now preserves any recorded engine (built-in or custom) and only falls back to Claude when no engine was ever recorded, matching the documented vendor-coercion contract.
- c6a326b: Sidebar polish. The PROJECTS region no longer reserves the full scroll-cap height as dead space when there are only a few projects — it now shrinks to its actual rows (each card is 2 lines) and still scrolls once the rows exceed the cap. The view tab label is shortened from "Working session" to "Workspace" so it stops truncating in the rail.
- 0af1df2: Full-window surface pages (new-task, settings, update, quick-task, help) no longer respond to the workspace navigation chords. Previously Ctrl+Q (back to tasks), Ctrl+[ / Ctrl+] (switch tab), and Ctrl+T / Ctrl+Shift+T (new tab) fired from the session-global tmux root table even while a surface page was open, yanking you out of a half-filled dialog. These windows now carry a `@kobe_surface` tag; the tab-switch chords no-op there and the new-chattab / back-to-tasks handlers return early. In-pane chords (Ctrl+hjkl) and prefix-gated ones were already harmless on a single-pane surface, and window management (close / rename) is left working.

## 0.7.35

### Patch Changes

- 2754844: New-task dialog focus styling. A focused field label (`repo`, `engine`, `from branch`, the clone fields…) is shown primary + bold + underline; unfocused labels stay muted. The active mode tab and selected engine keep their ▸ + bold + primary look (the active mode tab also underlines while the mode selector itself holds focus, and the `claude`/`codex` chips never underline). Input values are left at their default colour. This replaces the earlier accent-hue-on-focus, which read as jumpy.
- 65ca80b: Reworked the new-task dialog into a single top-to-bottom keyboard flow. The mode tabs (For Existing / New Repo / Adopt) and the engine selector are now real focus stops — the dialog opens on the mode row so ←/→ switches the mode immediately, Tab walks down `mode → engine → repo → branch → Create`, and the Create button moved to the bottom-right where "tab through, then commit" expects it. Picking a directory in the repo / clone-parent pickers now **selects** it (Enter or click) and advances to the next field instead of drilling endlessly into its children; keep typing to browse deeper. Enter on the last field creates the task directly (no second press on Create).
- cd33272: Friendlier, actionable error when a task's folder isn't a git repo. Instead of leaking git's bare `fatal: not a git repository`, both the new-task dialog's inline validation and the worktree-creation toast now explain why a task needs a git repo and hand over the exact fix (`git init && git add -A && git commit -m "init"`), noting that non-git folders will be supported later.

## 0.7.34

### Patch Changes

- e398209: Bundle the built web dashboard with the default kobe package and build it as part of `bun run build`. The web UI now imports JetBrains Mono through the Vite bundle via `@fontsource/jetbrains-mono` instead of relying on a checked-in public font file.
- 7d3b700: Web and desktop now route browser HTTP/SSE traffic directly through the kobe daemon instead of starting a standalone kobe-web bridge process. The daemon owns the web route table, RPC allowlist, SSE snapshot stream, session/spec routes, and optional static hosting; web dev and desktop only start Vite and the Node PTY sidecar.
- 4c7f5a2: Internal: centralize browser dashboard daemon-web-transport connectivity policy and rename the active SSE snapshot/channel types away from the retired bridge vocabulary.
- e387a75: Add an experimental `kobe-desktop` workspace: a thin Electron shell that launches the existing `kobe web` dev stack on a free local port block and opens it in a desktop window without changing the daemon, tmux, or web bridge architecture.
- 2ebd70c: Tasks pane project filtering is now a global UI preference shared across every task session. Pressing `ctrl+p` in one session updates the project scope everywhere, and entering another task no longer reveals that session's stale local filter state.

  The Tasks pane also keeps its collapsed keys legend one row above the tmux status bar and splits sidebar overflow into independent PROJECTS and TASKS scroll regions, so a long task list no longer pushes project rows out of view.

- 22f9866: Internal: repo init prompt delivery now flows through a typed launch-time contract so engine session creation distinguishes repo first messages, explicit user prompts, and no automatic first message without ad hoc init-prompt suppression at each launch path.
- afffd1e: Minify the published TUI bundle and keep web assets out of the default package.
- 95bab44: Internal: daemon file-watch mechanics and read-only git environment policy now live behind shared helpers. The keybindings/UI-prefs watchers reuse one directory-watch trigger, and pane/daemon git probes share the same `GIT_OPTIONAL_LOCKS=0` policy module.
- d2a319b: Internal: shared several duplicated implementation policies behind deeper modules. Shell command quoting now lives in one tested helper, long-lived pane row identity reconciliation is shared by FileTree and Sidebar, and the web bridge plus PTY sidecar use one Origin policy module for loopback/LAN-host checks.
- fbf12cb: TUI tmux sessions now stop a second differently-sized SSH/local client from letterboxing the active screen. Before attaching or switching into a task, kobe marks already-attached clients with conflicting terminal dimensions as `ignore-size` and sizes the target window from the entering client, so a monitoring terminal no longer shrinks the task grid on the screen you are actively using.
- 38be0a6: Theme the full kobe tmux chrome instead of only pane borders. The dedicated `-L kobe` tmux server now derives the bottom status/window bar, status-left/right styles, command prompts, copy-mode selection, pane picker colors, and pane borders from the active kobe theme, so switching themes fully restyles the ChatTab bar without touching the user's real tmux server.

  Make live theme propagation reliable when Settings writes the shared state file. The daemon now polls the tiny UI prefs file as a safety net for missed `fs.watch` tmp+rename events, so the selected-theme marker and already-running Tasks/Ops panes converge on the same theme as tmux chrome.

- 37ea989: Tasks pane gains a project filter: press `ctrl+p` or click the Project scope row to cycle between all tasks and each saved project. This keeps PROJECTS as a separate main-session section instead of restoring repo grouping, while the TASKS section narrows to the selected repo and still composes with `/` search, Working/Archives, and recent sort.
- c36738c: Internal: the tmux URL opener command now lives behind the tested Session Layout module instead of being assembled inline in the imperative session applier. The command shape, fzf fallback, opener, and tmux socket quoting are covered by the existing tmux layout test surface.
- d9062e0: The Tasks pane now shows only one PROJECTS row for a saved repo even if older state contains duplicate `main` task records, and `ensureMainTask` now dedupes repo-root, subdirectory, symlink-resolved, and trailing-slash variants before creating a new project row.
- 09d39b7: Centralize the web dashboard's best-effort active-task RPC policy behind a small shared helper.
- 448749b: Internal: kobe-web bridge requests now go through one typed API client seam. Route clients describe JSON/query/body/fallback intent while shared code owns request construction, JSON/text error extraction, and status-shaped `ApiError`s.
- a94b37a: Share the web module-store subscription primitive across board filters, rail state, toasts, and engine pickers.
- afe44b8: Defer the web issue editor panels so the Board and Issues routes no longer eagerly load the rich markdown editor bundle.
- 22f9866: Refactor the web PTY sidecar session lifecycle behind a dedicated manager while preserving attach, reattach, send, resize, close, and process-exit behavior.
- f431ece: Web dashboard shortcuts and notifications now mount at the route root, so Board
  and Issues get Cmd/Ctrl+K, `?` help, New Task, settings navigation, and toast
  delivery instead of only the workspace shell. Toasts now expose alert/status
  live regions so errors and notices are announced to assistive tech.
- dda045f: Web issue starts now read as user stories that spawn kobe sessions, and the web bridge's canonical tmux session path runs the same repo init prompt contract as TUI entry. Web PTY issue prompts still suppress the repo init prompt so explicit story instructions are not duplicated.
- 9d8fd19: Internal: Worktree content reads now go through one ExecHost-backed module instead of each surface spawning local git or reading local files directly. File tree git status/listing, Ops preview diff/code reads, and the web diff route now share the same local/remote Worktree git path, preserving lock-free `GIT_OPTIONAL_LOCKS=0` reads and the web route's timeout behavior while allowing registered remote Worktree paths to be inspected through SSH.

## 0.7.33

### Patch Changes

- dda80e9: Creating a task with `n` now drops you straight into the new task's engine pane, ready to type the first prompt — instead of just landing the cursor on it in the Tasks list. The full new-task flow now mirrors the prompt-first `f` quick-create's jump on both surfaces (the dedicated `kobe new-task` tab and the in-pane overlay), and the repo's `init-prompt.md` fires as the engine's first message just as it does on a normal enter. Adopting existing worktrees enters the last one. The proven "build session + switch-client" jump is now a shared helper reused by quick-task, new-task, and the Tasks pane.
- 9653cd7: TUI task sessions now expose tmux-native layout controls: temporary middle workspace shell splits capped at four panes, Tasks pane hide/restore, file/Ops pane hide/show, and terminal hide/restore by moving panes to a background tmux window without killing their processes.

## 0.7.32

### Patch Changes

- 7357f3f: Web Board now renders the selected project's empty Kanban columns even when it has no issues yet, so new or empty projects still show the Backlog / In progress / Done board structure instead of a blank empty-state page.

## 0.7.31

### Patch Changes

- 3ac6c22: Web Board issue execution is now scoped to one current project instead of an all-projects kanban: the project selector is a compact repo dropdown (not a row of tabs), is always present when projects exist, includes empty saved projects, and issue starts create worktrees under that selected project. Linked issue drawers also gain a Prompt merge action that inserts a finish/merge prompt into the issue task, asking the agent to summarize, verify, merge back into the current project's main branch, and mark the issue done.

## 0.7.30

### Patch Changes

- 6351a2d: Fix the workspace layout flashing to the aligned size the first time you open a task from the Tasks list — the target window is now fit + healed to your terminal before the switch lands, so it no longer reflows on screen. A manual Tasks-rail / right-column drag is also captured live, so it's no longer discarded when you then resize the terminal, and live-resize layout healing is coalesced so a drag-resize no longer thrashes.
- f5c0c36: Internal: the daemon's lazy-shutdown + collector-gate policy is now a deep, unit-tested module (`DaemonLifetime`) instead of loose functions and a shared `stopping` flag scattered across `server.ts`. The gui refcount, the idle-shutdown grace timer, the collector gate, and the stopping flag — three interdependent rules — now live behind one small interface, with the live client set still its source of truth (no counter to drift) and an injected clock so the policy is testable without a real socket. No behavior change; the end-to-end socket tests are unchanged and a new isolated unit test pins the rules.
- 2152382: Internal: the daemon's `task.status` handler now validates an inbound status against a single source of truth — `TASK_STATUSES` / `isTaskStatus` in `types/task.ts`, kept in sync with the `TaskStatus` union by a compile-time exhaustiveness check — instead of a hand-maintained six-way `!==` chain that would silently drift when a status is added. No behavior change.
- 4827465: Internal (web): the status-dot color and label are now derived together in one `activityMeta` switch (`src/lib/activity.ts`), so a new engine state can't get a color without a label; `activityColor` / `activityLabel` remain as thin accessors. The broader "unify activity + triage + notify into one engine-state meta" idea was declined and recorded as ADR 0002 — those three encode deliberately different policies (notably, `rate_limited` is a UI attention bucket but NOT a desktop-notification trigger, and triage also depends on worktree changes), so merging them would have regressed notifications. No behavior change.
- c68de0c: Internal (web): the substring-search mechanic shared by the rail, board, and transcript filters now lives in one place (`textMatchesQuery` in `src/lib/text-match.ts`) instead of being re-implemented in `matchesTask`, `filterBoardCards`, and `messageMatchesQuery`. Each surface keeps its own field projection (what text gets searched) but delegates the trim/blank/case-insensitive rule, so it can't drift between search boxes. The rail search now also treats a whitespace-only query as "no filter" (it already did for the board and transcript) — a small consistency fix. The glob (`diff-filter`) and subsequence (`fuzzy`) matchers are intentionally left separate as different algorithms.
- 309f9bb: Internal (web): vendor-identity rules now live in one module (`src/lib/vendor.ts`) instead of being split three ways. The unset-vendor default (`"claude"`) was independently re-coalesced in `engineLabel` (engines.ts), `distinctTaskVendors` (task-list.ts), and `defaultReviewTemplate` (review.ts); the per-row "engine label only when the workspace mixes engines" rule was inlined in AppShell. All of it — `DEFAULT_VENDOR` / `resolveVendor` / `engineLabel` / `distinctTaskVendors` / `isMixedEngineWorkspace` / `perRowEngineLabel` — now lives behind `vendor.ts`, so the default is one line and the rules are unit-tested without rendering a row. `engines.ts` keeps only its job: fetching the engine-owned list from the bridge. No behavior change.
- 7079d33: Final audit fixes:

  - **Auto-title no longer names a task after slash-command boilerplate.** When a Claude session's first action was a slash/bash command (`/clear`, `/model`, `!cmd`), Claude writes an injected caveat and a `<command-name>` breadcrumb before the real prompt, and kobe titled the task from that boilerplate. Those injected rows are now filtered out (mirroring Claude Code's own human-turn filter), so the title comes from the user's actual first prompt.
  - **Issues board no longer flickers a stale state.** An unrelated repo's live issue push could briefly re-apply this repo's older snapshot over a just-fetched newer one; a push is now skipped when its snapshot hasn't actually changed.
  - **Diff gutter line numbers.** A zero-length line inside a hunk is treated as a separator instead of a context line, so it can't offset every following line's number.

- d755598: Fix a batch of edge-case bugs surfaced by an audit:

  - **Daemon socket UTF-8 corruption.** A multibyte character (CJK, em-dash, emoji) in a task title, field note, or prompt could be split across two TCP chunks and decode to replacement characters (`�`). Both socket read paths now hold partial sequences across chunks with a `StringDecoder`.
  - **Web tab migration crash.** A stored tab with an unrecognized `kind` (a forward-version or corrupted entry) passed straight through and later crashed the live SSE store update; it now degrades to a vendor tab, and a `file` tab that lost its path degrades to an empty chooser.
  - **PTY sidecar.** Concurrent attaches to the same tab could orphan a PTY process (uncloseable, invisible); spawns are now single-flight. PTY writes/resizes on an exited handle no longer crash the sidecar, and `/pty/close` now enforces the same localhost-origin policy as the other PTY routes.
  - **Workspace layout.** Switching away from a task while a pane was zoomed persisted a bogus right-column width into the shared layout; the capture now bails when the window is zoomed.

- c057109: `kobe api fanout --agents <vendor>:<huge-count>` now rejects an over-cap count up front instead of allocating the whole array (and risking an out-of-memory) before the fanout cap check runs.
- 8f6dd64: Fix: a manually-reopened issue can no longer be silently snapped back to `done` by a racing task→done transition. The done-mirror previously read the issue store, then wrote it in a second, separate lock acquisition — a reopen landing in that window was clobbered by the stale decision. The reverse-lookup and the conditional flip now run atomically inside one `IssuesStore.mirrorTaskDone` lock.
- db47af2: More audit fixes:

  - **Issue store lost writes across repos.** The daemon issue store keeps every repo in one file but serialized writes per-repo, so two repos mutating concurrently could each read the file before the other's write landed and clobber it. Store access is now serialized on the file.
  - **Codex usage went stale.** When Codex `turn.completed` records carried no timestamp, only the first turn's token usage was kept and every later turn was discarded, so the session reported stale numbers. It now follows file order to the latest turn.
  - **Codex session lookup.** A rollout file is now matched by its full session UUID instead of a loose filename suffix, and an empty session id resolves to nothing instead of an arbitrary recent session.
  - **`kobe daemon stop` with no daemon running** now reports cleanly and exits 0 instead of crashing with a "failed to start" error.

- 8f6dd64: Internal: the orchestrator no longer double-publishes `task.snapshot` on daemon boot. `subscribeTasks` fired the listener directly AND returned the task store's own eager-on-subscribe firing, so the daemon broadcast the full task list twice back-to-back at startup (and threw a caught error on the not-yet-loaded path, since the store's `list()` asserts loaded). It now relies solely on the store's single delivery (eager when loaded, via `load()` otherwise). No behavior change beyond removing the redundant broadcast.
- 2989ec6: Fixes from a sweep of the TUI panes, web UI, and remote-exec code:

  - **Task titles no longer mojibake on emoji.** Deriving a title from a long prompt truncated on UTF-16 code units, which could split an emoji/astral character in half and leave an orphaned surrogate (a replacement glyph). Truncation now happens on whole code points.
  - **Remote (SSH) launch handles spaces/metachars.** The ssh connection arguments woven into a remote task's tmux launch line are now quoted, so a key path or control path containing a space no longer breaks the launch.
  - **Theme picker reflects a re-fetched theme set** even when the number of themes is unchanged (the snapshot compared only the count before).
  - **Web terminal** no longer writes to a disposed xterm when a PTY frame arrives mid-unmount (a harmless-but-noisy throw on fast tab switches).
  - **Tasks rail** re-highlights correctly when the selected task is deleted from another surface (the cursor could be left pointing past the shortened list).
  - **Board settings** surface a clear error if the quick-action templates fail to load instead of leaving the form silently disabled.

- 578e351: Fix: the web bridge now rejects cross-origin requests, closing a CSRF / DNS-rebinding hole. The bridge's mutating routes (`/api/rpc` reaches task create/delete/archive/rename/setVendor, plus `/api/settings`, `/api/issues`, `/api/issue-assets`, `/api/session`) had no Origin check, so any page the user merely visited could drive them — and a rebound `attacker.com → 127.0.0.1` page would even count as same-origin. The bridge now applies the same defense the PTY sidecar already used: only loopback Origins (or the deliberately-configured `KOBE_WEB_HOST` LAN host) pass; Origin-less non-browser clients are still allowed. No change for normal localhost / Vite-proxy use.
- 8f6dd64: Fix: a prompt submitted from the web terminal composer no longer occasionally sits unsent in the composer. The bracketed paste and the Enter were written back-to-back, so they could coalesce into one tty read and the engine treated the carriage return as paste content instead of a submit. The Enter is now deferred ~150ms to land as a separate read — the same split the sidecar's `/pty/send` path already used.
- 8f6dd64: Fix: an open web Board now reflects live cross-surface issue edits (from the TUI, `kobe api issue-*`, or another browser) even when the repo path is symlinked. The daemon keys an `issue.snapshot` by the repo's realpath'd git main worktree, which can differ from the board's raw `task.repo` key by more than a trailing slash — so trailing-slash normalization alone missed the push and the column only updated after a manual refresh. The live-push matcher now also matches by the canonical repoRoot a prior GET resolved for that board key.
- 578e351: Fix: a terminal/engine tab no longer briefly double-renders on (re)attach. The PTY sidecar added the new WebSocket to the live fan-out set _before_ replaying scrollback, so a chunk arriving in that window was both sent live and included in the replay — the browser wrote the same bytes twice, momentarily garbling the screen during heavy streaming. The scrollback is now snapshotted before the socket joins the fan-out, making attach exactly-once.
- 094301a: Internal: the Board's derivation logic — flattening loaded issue state across repos, folding in the optimistic pending-link, deriving the project chips, applying the chip + text filter, and assembling the per-project columns — was ~40 lines of pure logic trapped inside the 780-line `Board` component, only exercisable by rendering it. It now lives behind one `buildBoardView(input) → view` function in `lib/board` (with `collectBoardIssues` / `deriveRepoChips` / `filterBoardCards` underneath), each unit-tested directly; the component just calls it in one memo and renders. No behavior change.
- fe0b6fd: Internal: the issue-snapshot repo-key aliasing — which path variants (`/repo`, `/repo/`, a worktree checkout) a snapshot is cached under — was copy-pasted in three places (the SPA store, the bridge's daemon-link mirror, and the issues hook's `normalize`), so a fix in one could silently diverge and only one copy was tested. It now lives in a single dependency-free `lib/repo-key` module (`normalizeRepoPath` + `repoSnapshotAliases`) with one test that pins the contract, consumed by all three. No behavior change.
- 7981ec7: Internal: a workspace tab's kind drove two cross-cutting facts by string-matching scattered across the code — whether it owns a server-side PTY (the `kind === "vendor" || kind === "terminal"` guard appeared three times: reset-layout, prune-missing-tasks, and tab close) and how a fresh tab is titled (`Vendor N` / `Terminal N` / `Chat` / `New tab` built in five different helpers). Both now come from one `lib/tab-kinds` registry (`tabHasPty` + `nextTabTitle`), unit-tested in isolation, so a new tab kind declares its PTY-ness and title rule in one place instead of being threaded through every guard. The per-kind render stays a type-narrowed switch (the discriminated union keeps it type-safe). No behavior change.

## 0.7.29

### Patch Changes

- cdc3f38: Delete issues from the board: a Trash affordance on issue cards removes the
  daemon-owned issue record (gated behind a confirm dialog), backed by a new
  `delete` op in the issues store + a `deleteIssue` web client helper.
- a53fbd7: The web bridge can now store images uploaded from the Issues panel: `POST /api/issue-assets` saves a raster image under `~/.kobe/issue-assets/` (scoped per repo) and returns a stable URL, served back by `GET /api/issue-assets/<repo>/<file>` with an immutable cache and `nosniff`. A 10 MiB cap and a raster-only allowlist (SVG is rejected as an XSS guard) keep the store safe.
- df758ec: **Web dashboard: Issues panel** — `kobe web` gets an `/issues` page backed by the daemon-owned issue store, shared by a repo's source checkout and task worktrees. Switch projects with chips (or stay on the all-projects overview with per-repo status counts), browse a four-column board (`open` / `doing` / `hold` / `done`), search, create and edit issues in a detail drawer with markdown rendering, and one-click **quick start** an issue: kobe creates a task in that repo, flips the issue to `doing`, and pastes the issue as the engine's first prompt via the existing PTY delivery path. Reach it from the top bar (`CircleDot`) or the command palette. The bridge serves `GET/POST /api/issues` by proxying daemon `issue.*` RPCs, returning 400/404 for issue validation misses instead of surfacing them as server errors. Issue mutations now also broadcast daemon `issue.snapshot` pushes, so every open Issues pane updates live when web, TUI, or an agent changes the tracker.
- 6300230: The web dashboard Settings page now matches the TUI settings surface much more closely: it has section navigation, shared TUI appearance controls, editable engine launch commands and custom engines, board quick-action templates, experimental Dev toggles, browser notifications, and connection/version diagnostics. A new bridge-local `/api/settings` route reads and writes the shared `state.json` preferences through the same atomic state-store path as the TUI, so web and TUI changes stay aligned. Web new-task creation and Issues quick start now follow the shared default engine setting instead of silently falling back to the first detected engine or the daemon's Claude default. The engine editor now calls out that display names are labels only and warns when a flag-like value was typed there instead of the launch command. Issues are now daemon-owned instead of worktree-owned: the web dashboard proxies `/api/issues` to daemon `issue.*` RPCs, and `kobe api issue-*` lets agents update issues from their worktree without editing repo files. The bundled kobe agent skill now documents those issue commands and bumps its skill version so installed guidance can be refreshed.
- abde499: The Tasks sidebar now scrolls when the task list is taller than the pane. Previously, once you had more tasks than fit on screen, pressing j/k (or the arrow keys) moved the selection but the list never scrolled — the highlighted task walked off the bottom edge and navigation looked frozen. Two things were wrong: the rail's outer box had its `flexShrink` silently forced to 0 by opentui's width setter, so it grew to its full content height instead of shrinking to the pane (leaving the inner scrollbox with nothing to scroll), and there was no effect to keep the cursor row in view. The rail is now bounded to the pane height and the viewport follows the cursor, matching the file-tree pane.
- 11d6e19: The Tasks sidebar key legend is now a tight, curated set of ten rows instead of the long list that overflowed the pane. The footer now shows only the high-traffic chords — full help (F1), new task (n), settings (s), open (enter), focus engine (→), open wt (o), delete (d), views ([/]), move panes (⌃hjkl), and tasks→detach (⌃Q). The rows it dropped (sort, move/merge, un·archive, name/branch/engine, and the per-tab tmux chords for switch/new/engine/rename/close) are all still reachable from the F1 full-help dialog. Each row stays keymap-derived, so user overrides and unbinds in keybindings.yaml are still reflected and a live reload re-renders the legend.
- af74fd5: The `kobe web` browser dashboard is slimmer and clearer. The top nav drops from three buttons to two — **Board** and **Issues** — and the standalone `/overview` mission-control route is gone; its triage now lives in the rail status chips and the Board's attention-filter chips, which share one `lib/triage.ts` engine instead of a separate Overview surface. Several little-used extras were removed along with it: the branch conflict radar, transcript copy-as-Markdown, the Task panel's Copy-link / share helper, PR-transition desktop notifications, the router devtools, and a few redundant Settings sections. To make the trimmed-down dashboard explain itself, the Board, Issues, transcript, diff, Settings, and Adopt surfaces now each render an offline/empty-state hint (for example "no tasks yet" or "daemon offline, reconnecting") instead of going blank when a daemon is down or a surface has nothing to show.
- a53fbd7: Tasks can now carry an engine reasoning/effort level (e.g. Codex's `model_reasoning_effort`). The level is stored on the task, survives daemon restarts, and is applied to the engine launch line only when the task's engine actually supports it (Codex today) — any other engine, or an unknown level, is a no-op. Engines advertise their available effort levels through the engine registry, so the web UI never hard-codes the options.
- 5f83cb9: Unified board v2: Workspace and Board are now peer views with a top-left toggle (no back-link). Issues decouple from tasks — a task no longer reverse-references an issue (`Task.issueId` dropped); the issue→task link is one-way via `Issue.taskId`, the board dedups an issue whose linked task is live, and task→done mirrors to its issue by reverse lookup. The board is the ticket-intake surface: a slide-in panel creates issues with title/description and pasted/dropped image uploads (disk asset store under `<KOBE_HOME>/.kobe/issue-assets/`, served by the bridge, safely rendered), then Save or Execute-immediately. Clicking an issue opens a detail drawer to edit it and pick engine + reasoning effort before Start; issue cards carry a one-click quick-start and drop the inline status buttons. Task cards drop the redundant hover column-jump tags (drag still moves them).
- 3fe743a: **Web dashboard: unified Board** — Issues and tasks now live on one project-grouped kanban instead of separate pages. The board's Backlog column is the project's open issues; `in_progress` / `in_review` / `done` are its tasks. An issue and the task it spawned are associated by id (`Issue.taskId` / `Task.issueId`), so a started issue is deduped out of Backlog and its card carries a `#<issueId>` back-link to the originating issue; deleting the task resurfaces the issue back into Backlog. Clicking a Backlog card opens an editable drawer where you pick an engine and Start, which creates the task in that project, links it, and pastes the issue as the engine's first prompt. Task `done` mirrors back to the linked issue. Top-bar navigation is now just Workspace and Board.

  This also removes the dead conflict-radar feature end-to-end — the now-unused `task.conflicts` collector, channel, protocol/store/types members, and SSE wiring — along with the orphaned prompt-preview module. The `docs/design/conflict-radar.md` design report is deleted and its remaining references (dispatcher.md) cleaned up.

- c467a7f: Show every release note between the installed and latest kobe versions on the update page, grouped by version inside the existing scrollable release-notes panel, instead of showing only the latest release.
- 9606a0d: Web dashboard polish. The kanban board and the `/issues` page no longer flash the empty "no issues yet" state for a frame on load: both now wait for the initial issue fetch to actually resolve before deciding the board is empty, so a populated board renders straight away instead of twitching from empty to full (the gate is derived from whether the fetch has landed, not from a loading flag that only flips after the first paint). The Settings page is a level flatter — each section is now a bold-caps header over its controls instead of a bordered card wrapping already-bordered rows, which drops a redundant box-in-box-in-box nesting that was most visible on the Engines list. The task rail's status chips are trimmed to **All** and **Needs**: the low-traffic **Run** (engine running) and **Dirty** (uncommitted changes) quick-filters are removed, keeping the see-everything and attention-triage filters that carry the value, while the underlying buckets still drive the Board and the tab badge.
- 41d624c: Fix an "Invalid hook call" error that broke the web dashboard's kanban board: the monorepo carries two React versions (the web app pins ^19.2, the branding package pins 19.0), and `@dnd-kit`'s loose `react >=16.8` peer let the board's drag hooks resolve the second copy, so `useSortable` ran against a different React dispatcher. The web build now dedupes `react`/`react-dom` to a single copy, so the board's drag-and-drop renders cleanly.
- 2042cf6: The task rail and Overview cards now show which engine a task runs (Claude, Codex, …) — but only when the workspace actually mixes engines, so a single-engine setup stays clean instead of repeating the same label on every row. The label is engine-owned (resolved through the engine registry), and the "is this a mixed-engine workspace?" check is a small shared, unit-tested helper.
- 6596974: Fix the engine chip showing two different labels for the same engine in a mixed-engine workspace: an unset task vendor now resolves to the registry's "claude" label (and any user display-name override) exactly like an explicit `vendor: "claude"`, instead of a hard-coded lowercase fallback — so two tasks on the same engine never render mismatched chips or tooltips.
- a53fbd7: Add the backend for the web Issues panel: a daemon-owned issue tracker (create / edit / set-status / link / unlink / delete), keyed per repo by git common-dir and persisted at `~/.kobe/issues.json`. The daemon exposes it over `issue.list` / `issue.mutate` and republishes a repo's issue snapshot on every change; finishing a task whose issue is linked mirrors that issue to done automatically. Conflict radar is unchanged and keeps publishing alongside the new issue channel.
- ce37b59: The command palette (Cmd/Ctrl+K) now lists tasks most-recently-active first and shows a live engine-activity dot on each — so the task you were just in is near the top, and you can see at a glance which tasks are running, waiting, or idle while you jump. The activity dot reads live engine state at render, so it stays current without rebuilding the command list on every engine tick.
- 3305f54: The browser tab title now shows a "(N) kobe" attention badge when N tasks need a human (waiting on input, errored, or rate-limited) — so a backgrounded dashboard tab tells you at a glance how many sessions want you, the visual complement to the desktop notifications that works even without notification permission. The count is the same "Needs you" set the board surfaces (shared `triage`), updates live on every route, and drops back to a bare "kobe" when nothing is waiting.

## 0.7.28

### Patch Changes

- dfbd36e: The Tasks pane's keys-legend toggle (Shift+/) now stays in sync: a local collapse/expand of the keys hint is no longer immediately overwritten by a stale ui-prefs replay from the daemon (the prefs sync now reacts only to genuine daemon-payload changes). Thanks to Allen (@ZHallen122) for the fix.

## 0.7.27

### Patch Changes

- 61ff587: Recent sort no longer reshuffles the projects (repo) rows. Selecting a project bumps its recency timestamp, so "recent" mode was reordering the project list under the user every time they opened one; now projects keep a stable order (alphabetical by repo in the TUI, incoming order in the web rail) in both sort modes, and only the worktree-task groups reorder by recent use.
- f30219c: The Changes pane's file filter now understands globs and exclusions, not just substrings: type `*.test.ts` to show only test files, `src/*` to scope to a directory, or `!*.json` to hide everything matching a pattern. A query with no `*` and no leading `!` keeps the old case-insensitive substring behavior, so nothing changes for plain text.
- f77052a: Hardening from an adversarial review of the new Changes-pane glob filter: a pattern with several consecutive `*` (e.g. `**`, or `****` from key-autorepeat) no longer freezes the tab — runs of `*` are collapsed before building the match regex, removing the catastrophic-backtracking shape that the per-keystroke filter could hit. Negation now also works with surrounding whitespace (` !*.json`), and the transcript's per-message copy button reserves a gutter so it never paints over a turn timestamp and reveals on keyboard focus.
- fe179ef: Desktop notifications can now be toggled per event type in Settings → Notifications: "Task attention" (a task needs input or errored) and "PR updates" (checks, ready to merge, merged) are independent checkboxes under the master switch, so you can keep the pings you want and mute the rest. Both default on, persist locally, and gate through one shared opt-in check alongside the existing permission + page-hidden rules.
- e543d17: Hover any message in the Chat transcript to copy just that message as Markdown — a per-message copy button next to the existing whole-session copy, so you can grab one assistant answer or tool result without taking the entire transcript. It serializes the message the same way the full export does (role heading, tool call + resolved output, thinking blockquotes), respecting the hide-tools toggle.

## 0.7.26

### Patch Changes

- 9636be2: Make the `kobe web` browser dashboard discoverable. It now appears in `kobe --help` / `kobe -h` (it was fully functional but absent from the top-level usage, so the only way to find it was guessing the subcommand or reading the source). Both READMEs gain a "Browser dashboard" section showing `kobe web` / `kobe web --port` and pointing at `docs/design/web-dashboard.md`.
- 281440f: Fix an "Invalid hook call" error that broke the web dashboard's kanban board: the monorepo carries two React versions (the web app pins ^19.2, the branding package pins 19.0), and `@dnd-kit`'s loose `react >=16.8` peer let the board's drag hooks resolve the second copy, so `useSortable` ran against a different React dispatcher. The web build now dedupes `react`/`react-dom` to a single copy, so the board's drag-and-drop renders cleanly.
- 4efa09c: The keyboard-help overlay (`?`) now documents the recently-added signals so they're discoverable: a "Conflicts" entry explains the ⚠ badge (red = real merge conflict, yellow = file overlap) now shown across the rail, Overview, and board, and a "Needs you" entry covers the "(N) kobe" tab-title badge and the Cmd+K "Go to next task needing you" jump.
- 3c1defb: Overview cards now show the conflict-radar ⚠ badge the kanban board already carries: a task whose branch truly collides with another in-flight task is flagged right in the triage view (red for a proven merge conflict, yellow for a file overlap), with a hover tooltip naming the other task and the clashing files. The badge summary and tooltip text come from a shared, unit-tested helper in `lib/board.ts`, so the board and the Overview never drift.
- 0ae8ee3: The Overview header summary now includes an "N conflicting" count (red) alongside the existing need-input / running / dirty counts, so the fleet-level view of merge collisions is visible at a glance, not just per-card. It counts only tasks with a proven merge conflict among the shown set (file overlaps stay advisory on the cards) and hides itself when nothing is conflicting.
- 25a67d3: The command palette (Cmd/Ctrl+K) gains a "Go to next task needing you" command that jumps straight to the next task waiting on input — the one keystroke from "something needs me" (a notification or the tab-title badge) to the actual session. It cycles through the waiting tasks relative to the active one, so repeated use walks every task that needs you, and it only appears when at least one task is actually waiting.
- a3fd40e: Polish from an adversarial review of the attention/conflict waves: the command palette no longer rebuilds its command list on every engine-state push while it's closed (the build is gated on open and the "needs you" set is snapshotted at open time), which also stops the head-of-list "Go to next task needing you" command from shifting the keyboard cursor when a task changes state mid-session. The conflict ⚠ badge now carries a `role="img"` + `aria-label` (e.g. "2 merge conflicts" / "1 file overlap") so screen readers convey the level and count instead of an unlabeled glyph.
- 51580f8: The task rail now shows the conflict-radar ⚠ badge on its rows, completing the cross-surface story — a task whose branch collides with another in-flight task is now flagged in the always-on rail, the Overview, and the board alike (red for a proven merge conflict, yellow for a file overlap, hover names the counterpart). The simple-tooltip badge is now a shared `ConflictChip` next to `PrChip`/`ChangesChip`, and both the rail and the Overview render it from the same unit-tested `lib/board.ts` helpers.
- a5c996e: The browser tab title now shows a "(N) kobe" attention badge when N tasks need a human (waiting on input, errored, or rate-limited) — so a backgrounded dashboard tab tells you at a glance how many sessions want you, the visual complement to the desktop notifications that works even without notification permission. The count is the same "Needs you" set the Overview shows (shared `triage`), updates live on every route, and drops back to a bare "kobe" when nothing is waiting.

## 0.7.25

### Patch Changes

- ed1819c: **Opt-in auto status flow** — flip on `Auto status flow` (Settings → Dev → Experimental, i.e. `experimental.autoStatus` in state.json, live-read) and the board starts moving itself: when an engine begins a turn on a `backlog` task the daemon advances it to `in_progress` (a pure rule — starting work is unambiguous), and every claude session kobe spawns gets its task id baked into the system prompt via `--append-system-prompt` with the instruction to run `kobe api set-status --task-id <id> --status in_review` once the work is genuinely done — the agent is the one party that knows whether its turn ended "complete" or "asking you a question". Strictly one-way: only `backlog → in_progress` and agent-reported `in_review`; `done`/`canceled` stay yours, and cards you place manually are never touched. Injection applies to newly spawned sessions; codex sessions move by hand until that adapter grows an injection point.
- ed1819c: **Board cards keep a manual order inside each column** — dragging a card within a `kobe web` board column now persists its slot via a new `task.reorder` daemon RPC and a sparse fractional `position` on the task (web-board-only: the TUI sidebar's ordering and `recent` sort are untouched, and a reorder never bumps `updatedAt`). Un-dragged columns now order by creation time instead of last-update, so cards stop shuffling while engines run. Terminal columns (`Done`/`Canceled`/`Error`) cap at the 30 most recent cards with a `+N more` note — archiving stays the way to thin them.
- ed1819c: **Drag board cards between status columns** — on `kobe web`'s `/board`, drag a card (anywhere with the pointer, or its grip handle with the keyboard: Enter to lift, arrows to jump columns, Enter to drop) onto another column to move the task's lifecycle status. The drop paints instantly and the daemon round-trip confirms; a refused move (e.g. the `done` ↔ `error` guard) rolls the card back with a toast naming the blocked transition. Dragging disables with a `read-only (offline)` chip while the daemon or stream is down, so a drop can never silently vanish. Daemon RPC errors now carry their error name end-to-end (daemon → bridge → browser), so the web UI can branch on typed failures instead of string-matching messages.
- ed1819c: **Move a board card without dragging** — hovering a card on `kobe web`'s `/board` slides in a bottom bar with one tag per primary status (`Backlog / In progress / In review / Done`); clicking a tag jumps the card straight to that column, landing at the top. The current column's tag is highlighted, the peek eye lives in the same bar, and tag moves go through the exact same optimistic-paint + rollback pipeline as drag-and-drop. `Error`/`Canceled` stay drag-only.
- ed1819c: **Peek a session from the board** — every card on `kobe web`'s `/board` grows an eye button that slides in a drawer with the task's LIVE engine terminal and transcript, no navigation away from the board. The drawer attaches to the same server-side PTY the workspace drives, so it's one engine session viewed from two places; closing the drawer only detaches (the session keeps running, scrollback replays on reopen), and `Esc` closes it except while the terminal owns the keyboard. Peeking a task whose session isn't running starts it — same as opening the workspace's vendor tab.
- d57ced5: **Open-PR button + editable quick-action templates** — `Done` cards without a PR grow a pull-request button that asks the task's own session to push the branch and `gh pr create` (the agent that did the work writes the title/body, following the repo's conventions). Both quick-action instructions are now template-editable in `kobe web`'s Settings → Board quick actions (stored host-side in state.json): your template forms the first half, and kobe always APPENDS its clause after it — the review's one-time `done` authorization and the PR's reply-with-URL rule can't be edited away. Empty template = built-in default.
- ed1819c: **A kanban Board view in `kobe web`** — the new `/board` route lays every worktree task out as cards on status columns (`Backlog / In progress / In review / Done`, with `Error` and `Canceled` columns appearing only when occupied). Cards carry the live engine-activity dot, PR chip, uncommitted ±counts, branch and last-update time, and clicking a card jumps straight into that task's workspace. Reachable from the top bar's board icon or the command palette's `Open board`.
- d57ced5: **One-click review from the board** — `In review` cards grow a clipboard button that pastes a review instruction straight into the task's engine session (spawning it if it isn't running — output lands in scrollback, peek to watch). The instruction tells the agent to inspect the changes, run the relevant checks, and on a PASSING review run `kobe api set-status … --status done`; on a failing one, report findings and leave the status alone. The `done` authorization travels with the click — the always-on status protocol still only ever lets an agent self-report `in_review`, so a session that was never asked to review can never reach `done` by itself. Ships a new PTY-sidecar endpoint (`POST /pty/send`, same localhost-origin policy as the WS attach) that any future board quick-action can reuse.
- 8852524: **Field-notes dispatcher (experimental)** — flip Settings → Dev → "Field-notes dispatcher" and kobe's parallel sessions stop re-discovering the same gotchas: task sessions are told to file one-line notes when they resolve a non-obvious repo-level pitfall (`kobe api note`), the daemon forwards each note to the repo's main session over a new `session.deliver` channel, and that session — the dispatcher — autonomously relays it to the in-flight tasks that benefit via the new `kobe api dispatch` (daemon-routed; the front-end hosting the target session does the paste, so web-PTY sessions never grow a duplicate tmux twin). The dispatcher takes no action on merge conflicts — the conflict radar stays display-only. On the web board, a `dispatcher` chip appears when the board is scoped to a single project and opens that repo's main session in the peek drawer. Protocol prompts now bake the environment-correct CLI invocation, so dev-sandbox agents drive the checkout's CLI instead of a stale global `kobe`. Off by default; see `docs/design/dispatcher.md`.
- c885019: **The board splits by project** — when tasks from 2+ repos share the board, a chip row appears in the header (one chip per project, labeled by path basename with `parent/basename` disambiguation on collisions, plus a card count); clicking a chip filters every column to that project, clicking it again (or `all`) clears the filter. The chip filter composes with the `/` text filter, survives route changes like the text filter does, and snaps back to `all` if the selected project's last card disappears. Single-project boards are unchanged — the row only renders when there is something to partition.
- 73ae075: Pressing Enter in the Overview filter now opens the top match (first card of the bucket walk — "needs you" first) and returns focus to the grid, matching the task rail's filter behavior. The full keyboard flow is now `/` → type → Enter, or `/` → type → Tab/j/k to browse the filtered grid.
- 032e061: The web dashboard's Overview grid is now keyboard-navigable: j/k (or arrow keys) walk a highlight through the cards bucket by bucket, and Enter opens the highlighted task. Unlike the rail's j/k — which switches the active task live — the Overview highlight is local, so scanning the grid never navigates away mid-triage. The highlight follows filtering (a card that's filtered out drops the highlight) and scrolls itself into view past the fold.
- 37cd1a9: Overview cards in the web dashboard now show the task's PR chip (number, lifecycle color, check-state hover) — the same signal the task rail already renders, so a failing or ready-to-merge PR is visible from the triage view too. The chip's precedence rules (terminal lifecycle beats check state) moved into a shared, unit-tested module used by both surfaces.
- 7796e07: Overview cards in the web dashboard now show a one-line preview of the task's last user prompt, so the triage view answers "which task is this again?" without opening it. Previews come from the engine transcript through the existing history routes and are cached by transcript mtime — re-opening Overview costs one cheap sessions probe per task, and messages re-download only when the transcript actually changed. Codex tool-result plumbing on user-role records is skipped; a task with no prompt yet simply shows no preview line.
- 0e0d3c7: The web dashboard's desktop notifications now also cover PR transitions: CI checks flipping red or green, a PR becoming ready to merge, and a merge landing each ping you (same opt-in, permission, and page-hidden gates as the existing engine attention notifications; clicking jumps to the task). Transitions are rising-edge diffs of consecutive task snapshots, so a page load or a PR's first appearance never fires a notification blast.
- 66ef395: The web dashboard's task-rail filter state (text query, status chip, sort, archived toggle) now survives opening a task from the home route — previously the first `/` → task navigation remounted the rail and silently reset every filter, defeating the triage UI on its most common trigger. The state lives in an in-memory store: it persists across route navigation but deliberately resets on a full page reload, and the TUI's sort preference now syncs on a rising edge so a pref replay no longer stomps a local web-side sort toggle.
- c885019: **Conflict radar on the board** — cards whose branches truly collide are now connected by colored yarn lines on `/board`: the daemon dry-runs `git merge-tree --write-tree` between in-flight task heads (after a cheap touched-file-overlap prescreen), publishes pairs over a new `task.conflicts` channel, and the board draws a drooping line per conflicting pair with a hover tooltip naming both tasks and the clashing files; overlapping/conflicting cards also carry a ⚠ badge. Every radar git call is strictly non-blocking — async spawns with `GIT_OPTIONAL_LOCKS=0` (never takes `.git/index.lock` from under an engine's own commit), a global cap of 3 concurrent git children, per-card adaptive scheduling with timeout + backoff, and merge probes cached by head pair so they rerun only on new commits. On git < 2.38 the radar degrades to file-overlap badges (no yarn) instead of erroring.

## 0.7.24

### Patch Changes

- b8934b8: **Fix `kobe web` crashing at startup in the packaged build** — the PTY server in `dist/web-ui/` imports its sibling `pty-scrollback.mjs` (the bounded-scrollback ring from 0.7.22), but the build script only copied `pty-server.mjs`, so the npm-installed `kobe web` died with `ERR_MODULE_NOT_FOUND` before serving anything. The build now ships every sibling module the PTY server imports.

## 0.7.23

### Patch Changes

- b0ccfd2: The web dashboard can adopt existing git worktrees: a new Adopt-worktree dialog (the folder-in icon next to the task rail's `+`) scans a known repo for adoptable worktrees (`worktree.discoverAdoptable`) — showing each one's branch, dirty/kobe-managed flags, path, and last-activity time, with already-tracked worktrees marked instead of offered — and one click adopts a worktree into a task (`worktree.adopt`), selecting it. This makes the web UI self-sufficient for onboarding pre-existing worktrees without dropping to the TUI or CLI.
- 0eb5ad6: Web bridge hardening and lifecycle correctness: `POST /api/rpc` now forwards only an explicit allowlist of daemon verbs (a new daemon verb is no longer browser-reachable until deliberately exposed; connection-scoped and hook-ingest verbs are pinned out by a contract test); a web archive/delete tears down the task's tmux session after the RPC commits — the same orphaned-engine bug `kobe api delete` had, where the engine kept running invisibly — matching the TUI semantics (delete always kills, archive kills only when archiving); and a task deleted from ANY surface (TUI, api, another browser) now sweeps this browser's workspace tabs and kills their sidecar PTYs, so a deleted task's web engine processes don't keep running either.
- 5ad34ce: Internal: the bridge's HTTP route handler is extracted from `Bun.serve` into a testable `createRequestHandler` (injectable link + teardown), and a new integration suite covers the whole browser-facing surface against a fake daemon link — the `/api/rpc` allowlist (forward / 403 / 400 / 500) and the archive/delete teardown hook (delete and archive tear down, un-archive and rename do not), the SSE snapshot + sink registration, and the `/api/engines` / `/api/themes` / `/api/history` routes. No behavior change; this is the regression net for the surface the recent web waves added. The kobe-web architecture is now documented in `docs/design/web-dashboard.md`.
- fd4dc37: The web dashboard gains a structured Chat view — a third workspace tab kind ("Chat" in the tab chooser) that renders a task's persisted engine session as real messages instead of raw PTY bytes: user prompts, assistant text, collapsible thinking, and tool calls paired with their results by callId (codex emits results on user-role records, so the pairing — not the role — drives rendering). A session picker covers the task's whole on-disk history (latest follows automatically), a light mtime poll keeps the view live while the engine works (zero reads when nothing changed, paused while the browser tab is hidden), and the header shows a live context estimate plus session in/out token totals derived from the engine's per-turn usage records. Data comes through new bridge-local `/api/history` routes that read via the engine registry's neutral history readers — the web never parses a vendor transcript format, and session/vendor inputs are validated against path traversal (covered by tests).
- fe4c7de: Internal: cover the notes and history fetch clients — encoded request params, the notes PUT body, the history sessions/messages unwrapping, and error handling (status + detail / JSON error body). Web test count is now 103 (from ~18 at the start of this stream), spanning the bridge route surface and every pure helper.
- 81d4ec2: `kobe web` now prints which daemon home it's serving (`home: …/.kobe (production)` or `home: sandbox: <path>` when `KOBE_HOME_DIR` is set) right under the URL, so it's never a mystery whether the dashboard is showing your production task index or a sandbox — matching the `dev`/`dev:sandbox` banner.
- e4da9fd: The web dashboard gets a command palette (Cmd/Ctrl+K) — a keyboard-first launcher that fuzzy-matches every task (jump + set active in one keystroke) plus global actions (New task, Open settings). Arrow keys move, Enter runs, Escape closes; it opens focused, matching the TUI's keyboard-first muscle memory.
- 9068250: The web dashboard's engine prompt composer gains shell-like history: press ↑ to recall previously-sent prompts (newest first) and ↓ to walk back toward your in-progress draft. History is per-task and persists across reloads (localStorage). ↑/↓ only enter history when the caret is at the edge of the draft, so they still move within a multi-line prompt; once you're browsing, they keep walking the ring, and Escape exits history and restores your in-progress draft.
- 70ebd19: Web engine tabs gain a prompt composer under the terminal — type a prompt (Shift+Enter for multi-line) and Enter pastes it into the engine via bracketed paste + submit, the same delivery contract as kobe's tmux prompt paste, so driving a session no longer requires raw terminal typing. A dropped PTY WebSocket now shows a "detached — the session keeps running" bar with a one-click Reattach that reconnects to the same server-side PTY and replays its scrollback, replacing the old dead-end `[detached]` line.
- c2792f5: The web dashboard's Task panel gains a "Copy link" button next to "Copy path": it copies the task's deep link (`<origin>/task/<id>`) so you can paste it to a teammate or yourself and land straight on that task. Built on a new reusable clipboard helper with an execCommand fallback for non-secure contexts.
- 70ebd19: Web tasks are deep-linkable: selecting a task pushes `/task/<id>`, so a task URL can be shared/bookmarked/refreshed and browser back/forward walks your task-switch history. Visiting a task URL selects that task (and sets it active daemon-wide); archive/delete navigate back to the root, and a link to a since-deleted task falls back to the empty workspace once the snapshot proves it gone.
- 2cf91e9: `bun --filter kobe-web dev` now prints a startup banner showing whether it's wired to your PRODUCTION `~/.kobe` daemon or a sandbox home (with the resolved path and ports), so you can't mistake one for the other — and a new `dev:sandbox` script points `KOBE_HOME_DIR` at the same throwaway home the TUI's `dev:sandbox` uses (plus the `kobe-sandbox` tmux socket), so the bridge, the PTY engines, and tmux all run isolated and never touch production `tasks.json`. (Reminder: `bun run test` touches no daemon at all — that isolation was always unconditional.)
- 58a9ba6: Internal: cover the diff client (`fetchDiff`) — the `/api/diff` query it builds (worktreePath + the optional `namesOnly`/`path` hints), response normalization to `files[]`/`raw`, and error handling (server error message vs status fallback). 96 web tests.
- 4520a1d: The web dashboard's Changes pane gains a file filter: when a worktree has more than one changed file, a search box above the file list narrows it by path (case-insensitive substring) — type `src/`, a filename, or an extension like `.tsx` to jump to the file you want in a large diff. The filter clears automatically when you switch tasks, and an empty result shows a "No files match" hint instead of a blank list.
- 9e92286: The web diff view now renders a line-number gutter — a unified-diff parser computes old/new line numbers from each hunk header and shows two aligned gutter columns next to the content, so reviewing an agent's changes reads like a real diff instead of raw `+`/`-` lines. Added lines show the new-file number, removed lines the old-file number, context both; hunk and file-header rows span the gutter. The hunk-math is covered by tests.
- e3696f9: The web diff view now shows change-size stats: a `+a −d` chip in the full Changes header (summed across files), in each file-preview header (that file's counts), and the daemon's worktree total in the right-rail Changes list — so the scale of an agent's changes is visible at a glance. Counts come from the same unified-diff parser (excluding the `+++`/`---` file-header lines), covered by tests.
- d42cf0c: The web dashboard's file diff view gains a "wrap" toggle: by default long diff lines scroll horizontally (so columns stay aligned), and one click soft-wraps them to fit the pane instead — handy for long strings, prose, or minified content. Per-file-preview, off by default.
- 18a2c3b: Internal: cover `engineLabel` (vendor id → display label across New Task / Settings / workspace pickers) — known id → label, unknown id → raw id, missing id → claude default, empty list. 111 web tests, completing coverage of the package's pure helpers.
- c4c614b: The web dashboard's Chat-transcript search and Changes-pane file filter now clear on Escape, matching the task rail and Overview filters — so Escape consistently empties whichever search/filter box is focused across the dashboard.
- 00b43aa: Accessibility: the dashboard's modals (command palette, New Task, Adopt, confirm dialogs, keyboard help) now trap Tab focus inside the dialog and restore focus to whatever was focused when the modal closes, so keyboard users can't tab out into the page behind an open dialog. A shared `useFocusTrap` hook adds the trap + restore without disturbing each modal's own initial-focus behavior.
- c7b6cb0: The web dashboard's `?` keyboard-help overlay now documents the features added this round so they're discoverable: an "In the engine composer" section (↑/↓ to recall sent prompts), the palette's theme switching, and "Where things are" entries for the rail status chips + Overview triage, the Changes-pane file filter + diff wrap, the Chat transcript search + hide-tools toggle, and Copy link.
- b407ae6: The web dashboard gains a keyboard-help overlay (the web counterpart of the TUI's F1 help): press `?` (when not typing in a field) or click the `?` in the top bar to see the shortcuts (Cmd/Ctrl+K command palette, Esc) and where the main affordances live (New task, Adopt, Overview, tab kinds, Notifications). The command palette also gained a footer hint (↑↓ move · ↵ run · esc close).
- aa6d8a0: Web perf: the xterm terminal (the app's heaviest dependency) is now lazy-loaded, so it splits into its own chunk fetched only when a vendor/terminal tab first opens instead of bloating first paint. The dashboard's main chunk drops from ~352KB to ~68KB; xterm's ~288KB loads on demand behind a "Loading terminal…" fallback.
- 0eb5ad6: The web task rail now renders the daemon's live activity channels: per-task `+N −M` uncommitted-change chips from `worktree.changes` (the daemon's single git-status collector — no browser-side polling) and a spinning "materializing…" row state from `task.jobs` while a worktree is being created, both hydrated from the bridge snapshot so a late-opened browser sees in-flight state immediately. The rail also shows a proper connecting state before the first snapshot instead of a misleading "No tasks yet".
- 70ebd19: The web Changes rail, file-preview tabs, and diff pane now refresh themselves while the agent works: they key off the daemon's `worktree.changes` counts (already streaming over SSE), so an edit in the worktree re-fetches the affected diff within a collector tick — no browser-side git polling, and the previous patch stays on screen during a refetch instead of flashing a loading state. Manual ↻ still works.
- f03ac68: Harden the notes markdown renderer against a quadratic-time stall: a single line with a long run of unmatched `[` could make the link regex backtrack for seconds. The renderer now skips the link pass when a line has no `]`/`(` to match — pathological input renders instantly, real links are unaffected. (A focused adversarial XSS review confirmed the renderer has no injection bypass; this was the only finding.)
- 22d4f94: The web notes scratchpad gains a markdown preview toggle (Edit ⇄ Preview): a minimal, safe renderer (headings, lists, blockquotes, inline/fenced code, bold/italic, links, hr) turns notes into formatted text. Security-first — it escapes all input before composing tags (no raw HTML can be injected) and only allows http/https/relative link hrefs (`javascript:` and friends render as inert text), covered by tests including XSS cases. The preview re-themes with the rest of the dashboard.
- 4a37171: The web dashboard can notify you when a task needs attention: opt in from Settings → Notifications and you get a desktop notification the moment a task's engine transitions into "needs input" or "errored" while the tab is in the background — click it to jump straight to that task. Fires only on the rising edge (not every poll) and never while you're already looking at the page. Built for running many sessions at once: start them, walk away, get pinged.
- b64851a: The web dashboard's Overview (mission control) gains a filter box: type to narrow the triage cards across every bucket by task title, branch, repo, path, or vendor. With many parallel sessions, find the one you mean without scanning all four columns; the header counts reflect the filtered set, and an empty result shows a "No tasks match" hint. Keyboard-first like the rail: press **/** to focus the filter and **Escape** to clear it.
- e01a628: The web dashboard gains an Overview (`/overview`) — mission control for running many sessions at once. It triages every worktree task into attention buckets (Needs you: waiting on input / rate-limited / errored · Working: engine running · Uncommitted changes: idle with a dirty worktree · Quiet), each a card with the activity dot, branch, change chips, and relative time that jumps to the task on click. A summary strip counts how many need input / are running / are dirty at a glance. Reachable from a top-bar button and the command palette ("Open overview").
- 5c52ea1: The web dashboard's command palette (Cmd/Ctrl+K) can now switch themes: every available theme shows up as a "Theme: <name>" command (the active one flagged), so you can fuzzy-search "theme" or a theme name and apply it without opening Settings. When a web-local override is active, a "Theme: Follow TUI" command clears it so the dashboard tracks the TUI's theme again (parity with the Settings picker). The web-local theme override persists as before (override > TUI ui-prefs > claude).
- eb84431: Internal: cover the store's `pruneByTask` (the per-task side-table sweep that drops a deleted task's stale engine-state/job entries on each snapshot), including the same-reference-when-unchanged behavior that avoids needless re-renders. 87 web tests.
- 56ad7a2: Internal: cover `ptyUrl` — the PTY WebSocket URL builder (the `port + 2` sidecar convention, ws/wss by page scheme, and the tab/taskId/mode/cols/rows query params xterm sends). A regression here would break every terminal tab. 107 web tests.
- 1f67c68: The web dashboard's task-rail filter is now keyboard-first: with the "Filter tasks" box focused, **Enter** jumps straight to the top match (the first task in the sorted + filtered list) and blurs the box, and **Escape** clears the query. Type a few characters of a branch or title and press Enter to switch tasks without reaching for the mouse — matching kobe's keyboard-driven TUI.
- 3720bea: The task rail gets keyboard-first navigation: `j`/`k` (or `↑`/`↓`) move between the visible tasks and open them, matching the TUI's muscle memory — suppressed while typing in a field or while any dialog/palette is open. Also cleaned up the kobe-web lint state to fully pass `biome check` (the package's own lint wasn't exit-code-gated before, so a few latent unused-import / a11y / hook-dep items had accumulated).
- 1a8a46c: The task rail scrolls the selected task into view when it changes — so `j`/`k` keyboard navigation (or any selection) past the fold in a long task list keeps the active row visible instead of leaving it scrolled off-screen. No-op when the row is already visible.
- 0caecf2: The web dashboard's task rail gains status filter chips (All / Needs / Run / Dirty) under the search box: one click narrows the always-visible rail to tasks that need input, have an engine running, or have uncommitted changes — quick triage without leaving your current task or opening the Overview. Reuses the same triage rules as the Overview buckets, and combines with the text filter.
- 600d216: Settings gains a "Reset layout" recovery action (two-click confirm): it clears the per-task workspace tab layout (open tabs, splits, selection) back to empty and kills the open tabs' PTYs, for when the localStorage-persisted layout gets wedged or cluttered. Pure browser state — tasks, worktrees, and notes are untouched.
- a32ebd9: Web resilience + a first-prompt flow. A root error boundary now catches render crashes and shows a themed recovery card (with Reload / Try to recover) instead of a blank white screen — and notes that tasks/engines are untouched since it's a UI-only crash. A dismissable banner appears when the daemon behind the bridge goes offline (SSE still up), explaining that task data is frozen and recovers automatically. The New Task dialog gains an optional "First prompt" field: creating a task with one opens an engine tab and seeds the prompt into its composer, ready to send the moment the engine is up — no PTY-readiness guessing.
- e4da9fd: The web task rail now shows relative timestamps ("3m", "1d") and a PR status chip (number + lifecycle/check color) on each task row, and the right Task-tools panel — previously hidden entirely below the `lg` breakpoint, making rename/status/changes/notes unreachable on a phone — becomes a slide-in drawer toggled from a top-bar button on narrow screens.
- 396efe0: Fixes from an adversarial review of the web stream: the Chat transcript no longer snaps a manually-picked older session back to the latest on every poll tick (the interval captured a stale closure); the command-palette modal now actually traps focus (its always-mounted/return-null shape meant the trap never attached); the Changes list guards against out-of-order diff fetches so a fast task switch can't show the previous worktree's files; the diff parser resets hunk state at each `diff --git`, so a concatenated staged+unstaged patch no longer mis-tags the second file's headers (wrong gutter + inflated `+/−` counts); the theme picker's "following TUI" ↔ override badge updates even when you pick the already-active theme; the tools drawer closes on Escape from anywhere; and the bridge + PTY servers now bind loopback by default (not all interfaces) with a localhost-Origin check on the PTY WebSocket — closing the exposed-on-LAN hole while staying invisible for local use (`KOBE_WEB_HOST` overrides).
- e1d2abc: Follow-ups from a second review pass: the bridge's engine-state mirror now prunes to the live task set on each task.snapshot (it previously grew forever — a deleted task's trailing idle frame and every lapsed-to-idle task accumulated, bloating the snapshot each fresh browser hydrates from), and the SPA reducer no longer re-inserts an orphan idle engine-state for a task that was just deleted. Both were self-healing in the UI; this keeps the bridge mirror and store bounded. (The pass also confirmed the prior review's 7 fixes introduced no regressions.)
- 2926bb4: Fixes from a third release-gate review of the stream's newer changes: the markdown renderer no longer rewrites markdown inside `code` spans or pairs `*`/`[` across a code boundary (it now splits on code spans and transforms only the non-code parts), renders bold that contains italic (`**bold *x* more**`), and drops protocol-relative `//host` links to inert text per its "relative only" contract. The `j`/`k`/arrow task-rail nav no longer swallows arrow-scroll on a focused transcript/diff pane (arrows only navigate when the rail or nothing owns focus) and is suppressed while the Settings overlay is open. "Reset layout" navigates home so the deep-link route can't instantly re-select the cleared task. And the notes panel clears its buffer + drops to Edit mode on a task switch so the previous task's content can't flash during the async reload.
- 26ff7c8: The web Settings page is now functional instead of decorative: a theme picker with live swatch previews of every bundled theme (clicking one applies + persists a web-local override that takes precedence over the TUI's pushed theme; "Follow TUI" clears the override so the dashboard tracks the TUI again), an Engines card listing the detected built-in + custom engines, and the existing connection/version detail. The theme module now resolves precedence cleanly (web-local override > daemon `ui-prefs` > claude fallback) and applies the persisted choice on first paint.
- d4c9329: Internal: cover the bridge's `shellQuote` (it builds the engine launch command line that runs in the worktree) with tests, including injection attempts — a value with an embedded quote or shell metacharacters must stay a single quoted token and never break out to run extra commands. No behavior change.
- 3cbe4cc: The web dashboard's task rail is now fully keyboard-drivable: press **/** (the search-focus convention) to focus the "Filter tasks" box, then type and press **Enter** to jump to the top match. `/` is suppressed while typing in a field or with a dialog/palette/Settings open, and the shortcut is listed in the `?` keyboard-help overlay.
- c4fa182: Internal: cover the file-preview tab dedup — re-opening the same file from the Changes rail reuses its tab (per task), while engine tabs stay independent. 115 web tests.
- 71f50cd: Internal: the localStorage tab-kind migration (retired `notes` → empty chooser, legacy `chat` → `vendor`, unknown → `vendor`) is extracted to a pure `migrateStoredTab` and covered by tests, so stale browser state from an older build can't render an unknown tab or crash the SPA on load. 65 web tests now.
- 0eb5ad6: The web dashboard reaches task-lifecycle parity with the TUI: a New Task dialog (the `+` in the task rail) creates a real task — repo picker fed from the daemon's project rows with a free-path escape hatch, optional title/branch/base-ref, engine selector — and selects it; an Archived section at the rail's bottom lists archived tasks with one-click Restore; the Task panel gains branch rename, a Delete flow that mirrors the TUI's (non-force first, an explicit force confirm when the worktree has uncommitted changes), and a Restore banner on archived tasks. Native `window.confirm` is gone — archive/delete use themed confirm dialogs — and every mutation that used to fail silently now surfaces in a toast stack. Vendor pickers (Task panel, workspace tab dropdown, New Task) read the engine registry through the bridge's new `/api/engines` route (detected built-ins + custom engines with their display names) instead of a hardcoded vendor list that offered engines kobe doesn't ship.
- 4deb692: Internal: locked down the subtle web logic with unit tests. The notification rising-edge rule is extracted to a pure `shouldNotify()` and the theme precedence to `resolveEffectiveTheme()`, both covered; relative-time bucketing is covered too. Also made the theme module import-safe outside a browser (the palette fetch is gated to a window context). No behavior change — 60 web tests now (up from 38).
- 70ebd19: The web dashboard follows the TUI's theme, live: the bridge serves the TUI's 7 bundled theme JSONs resolved into the web's CSS token vocabulary (`GET /api/themes`, def-ref resolution mirroring the TUI's theme loader), and the SPA now consumes the daemon's `ui-prefs` channel — switching themes in any kobe session's Settings restyles every open dashboard immediately (new terminals pick up the matching xterm palette; the static claude palette stays as first-paint fallback). The Tasks rail also follows the TUI's sort-mode preference from the same channel.
- 8055800: Internal: lock the web theme palette resolution with a contract test — every one of the 7 bundled themes must resolve (def-ref chains and all) to a complete palette where every `--color-*` token the dashboard sets is a valid 6-digit hex, plus coverage for the `/api/themes` route. Guards against a theme JSON change silently dropping a token and breaking the web theming.
- a887d58: The web dashboard's Chat transcript gains a "tools" toggle: hide tool-call rows to read just the conversation prose (your prompts + the assistant's replies) without the tool-call noise. In a long coding session that's the difference between scrolling past hundreds of tool steps and scanning the actual back-and-forth. Tool calls return with one click; the toggle resets on task/vendor switch.
- abbd740: The web dashboard's Chat transcript gains a jump-to-latest button: scroll up into a long session and a "↓ latest" button appears in the corner — click it to snap back to the newest turn and re-enable auto-follow while the engine streams. It stays hidden while you're already at the bottom, so it never covers content you're reading.
- e30c676: The web dashboard's Chat transcript can now be copied as Markdown — a new button in the transcript header serializes the session you're looking at (respecting the active search filter and the hide-tools toggle, so you export exactly what's on screen) into a clean Markdown document on the clipboard, with a toast confirming the message count. Tool calls render as `↳ name` lines with their (truncated) output attached, thinking as blockquotes, and the heading carries the task title, engine, and message count — so you can paste a session into a doc, an issue, or a message to a friend.
- 824d4b4: The web dashboard's Chat transcript gains a search box: filter a session down to the messages that match a query, with a live "shown / total" count. It searches all of a message's content — prose, thinking, tool-call names + inputs, and tool result output — so a filename, command, or error term jumps you to the relevant turns in a long session (e.g. narrowing a 359-message transcript to the 2-4 that mention what you're looking for). The query clears on task/vendor switch, and an empty result shows a "No messages match" hint.
- 835258b: The web dashboard's Chat transcript now shows a relative timestamp ("3m", "2h", "2d") on each user turn, anchored to the right of the prompt — so a long session reads with periodic time markers and you can tell when an exchange happened. The full ISO timestamp is on hover; turns without a parseable timestamp render nothing.
- dbe432a: Internal: cover the Chat transcript usage math — `summarizeUsage` (session in/out token totals + the live context estimate, which is the last turn's full prompt = input + cache read + cache creation) and `formatTokens` (k/m suffixes). 91 web tests.

## 0.7.22

### Patch Changes

- 01a394c: Fix `kobe api delete` / `kobe api archive` leaving the task's engine running: scripted delete/archive committed the daemon RPC but never stopped the task's tmux session, so the engine subprocess kept running — orphaned and invisible to every kobe UI since the task was already gone from `tasks.json`, recoverable only via `kobe reset`. Teardown now runs in the CLI process after the RPC commits (the daemon never touches tmux by design), matching the TUI flows: delete always kills the session, archive kills only when archiving.
- 7643e80: Three latency/dead-key papercuts: `Ctrl+A` (line-home) works again in the New Task dialog's text fields — it was swallowed by the Adopt-tab select-all chord registered unconditionally with a handler-side gate (same class as the quick-task Enter bug); `kobe hook` no longer keeps the event loop alive ~500ms after each invocation (its stdin-race timer is now cleared); and engine binary discovery (`which` probes) is cached per process instead of re-running on every keypress and dialog open.
- 6ad2432: The Tasks pane footer keys legend now reflects your keybinding overrides — the sidebar letter rows derive their keycaps from the keymap instead of hardcoding defaults, so a chord you rebind (or unbind) in `~/.kobe/settings/keybindings.yaml` shows its real key (or drops the row), matching F1 help. Also: entering a task whose session is rebuilt through the live-session path now runs the repo's init script as the create path does.
- 4c2a72e: Fix engine-switch and lifecycle correctness in the tmux session layer: an in-place vendor switch (Tasks pane `v` then re-enter) now re-pins each chat-tab window's engine session id and respawns the Ops panes, so per-tab turn status, the `● new` activity badge, and tab auto-naming track the new engine instead of silently reading the old vendor's transcripts for the session's remaining life (KOB-232). The Ops activity badge also backs its transcript poll off toward 20s when idle, and the kobe-home Tasks rail now inherits the right environment so it can't read the wrong `tasks.json`.
- 61b221c: The daemon now keeps its background work proportional to attached front-ends: `subscribe` honours its `channels` filter (a subscriber receives only the channels it asked for, replay and broadcast — omitting it still gets everything, fully back-compat), the git-status / auto-title collectors pause when no pane is subscribed and resume on the next subscribe, and a half-built client orchestrator is disposed when its connection fails instead of leaking a reconnect loop.
- c6f5434: Two build/serve perf fixes. The `dist/web-ui` build output is now emptied before the fresh web bundle is copied in — vite hashes bundle filenames per build, so old `index-<hash>.js`/`.css` generations were accumulating in the published npm tarball forever; the tarball now carries only the current build's assets. The `/api/diff` route no longer spawns `git diff --no-index` one-at-a-time per untracked file (a worktree of newly scaffolded files made the Changes rail and file preview multi-second loads); untracked patches now run through a bounded worker pool (≤8 concurrent), so a repo with hundreds of untracked files can't fork-bomb git. The diff response payload is unchanged.
- 25faf9c: Web dashboard efficiency: the embedded terminal's scrollback no longer reflattens a 256KB string on every PTY output chunk (bounded chunk ring; the browser reuses one TextDecoder), and the daemon→browser SSE bridge only forwards the channels the SPA actually consumes instead of every daemon channel.

## 0.7.21

### Patch Changes

- ad366ff: Fix the quick-task page's "type a prompt, hit enter" path: Enter in the prompt field was silently consumed by a no-op key binding instead of reaching the input's submit, so creating required tabbing to the engine field first; arrow keys also couldn't move the cursor inside the prompt/branch inputs. Engine and branch keep defaulting from the firing task — a prompt and one Enter is all a quick task needs now, as designed.

## 0.7.20

### Patch Changes

- fbaa3e0: Big idle-efficiency pass — long-running kobe panes and the daemon now do dramatically less background work: task switches re-verify sessions with 4 tmux calls instead of 10 (attach/resize healing 6→3); turn/activity polling stops re-reading multi-MB transcripts when their mtime hasn't changed (Claude and Codex both — previously up to hundreds of whole-file reads per minute per pane); ChatTab auto-naming drops from ~450 to ~165 tmux calls/min by riding window options through the listing; sidebar branch labels stat .git/HEAD instead of spawning git every 2s (~150 spawns/min → ~0); the idle spinner tick no longer rebuilds every row's view 10×/s; the offline tasks.json poll is mtime-gated; the daemon serializes each broadcast frame once instead of once per subscriber; and keymap lookups are O(1) per keypress.
- 93214cc: Pane-focus polish in the tmux handover: the directional focus chords (ctrl+h/j/k/l, or your `tmux.focus` overrides) no longer wrap at window edges — pressing ctrl+h on the leftmost Tasks pane is now a no-op instead of teleporting to the rightmost pane (each bind is gated on tmux's `pane_at_*` edge variables). And in the Tasks pane, the Right arrow jumps back into the current window's engine pane (`tasks.focusEngine` — user-overridable, F1-visible, shown in the keys legend), the natural inverse of ctrl+h.

## 0.7.19

### Patch Changes

- ae63adb: Memory-leak audit, round two — five more long-session leaks fixed: sidebar rows now reconcile by identity so every task switch no longer recreates every row's renderables in every open Tasks pane; the engine-state map prunes entries for deleted tasks; a failed pane-side prefs connection no longer leaves an orphaned reconnect loop running forever; pending daemon RPCs are swept on forced reconnects instead of being retained (and awaited) forever; and auto-titles / Copilot history no longer pin multi-MB message buffers via substring retention.
- 320919a: Navigation and cycler chords are now rebindable in `~/.kobe/settings/keybindings.yaml`: `sidebar.nav` / `files.nav` (alternating `[down, up]` pairs — e.g. `sidebar.nav: [w, s]`), `files.hierarchy` (`[collapse, expand]` pairs), and `sidebar.view` / `files.tab` (`[prev, next]` pairs), with exact-count validation so a bad override keeps the default instead of scrambling directions. Shift-discriminated chords (gg/G, Shift+P, Shift+M) and the tmux-mirroring pane-focus set remain fixed, with accurate reasons shown in Settings.
- cf7c066: Task rows show a live "materializing" state while a large repo's worktree is being created. The daemon publishes lifecycle progress for the minute-class `task.ensureWorktree` operation on a new additive `task.jobs` channel (running → done/error, terminal phase guaranteed even on failure), and every attached Tasks pane — not just the one that initiated the switch — spins the row with a "materializing" subtitle until the `git worktree add` settles. The blocking RPC contract is unchanged; job entries are pruned against task snapshots so a task deleted mid-job never pins a phantom state.
- 320919a: The sidebar's `+N −M` uncommitted-change chips are now fed by ONE `git status` collector in the daemon instead of every pane polling git itself (previously N panes × M tasks of duplicated background subprocesses). The daemon publishes the full counts map on a new additive `worktree.changes` channel — republished only when something actually changed, with the same guards that fixed the 30GB-repo freeze (in-flight dedupe per worktree, timeout + SIGKILL, hard backoff for timed-out repos, adaptive cadence, `GIT_OPTIONAL_LOCKS=0`). Archived tasks and remote (`ssh://`) projects are never collected, and deleted/archived tasks' entries drop from the map. Panes render the pushes and spawn zero git processes while daemon-connected; the local per-pane poller survives only as the fallback when no daemon is reachable or an older daemon doesn't advertise the channel in its hello capabilities.

## 0.7.18

### Patch Changes

- 11e4f92: F1 help now opens as a dedicated full-window tab instead of an overlay squeezed into the narrow Tasks rail. The keybindings page sits alongside your chat tabs (same surface as Settings) and closes with q / esc / F1, returning to the previous tab. When no tmux session can be resolved, F1 falls back to the in-pane overlay as before. Also, dialogs are no longer translucent in transparent-background mode — the modal card now stays fully opaque so settings, confirms, and help stay readable; transparency keeps applying to the chrome around content only.
- 3d54b24: Two Tasks-pane preferences — the sort toggle (`t`) and the `── keys ──` legend fold (`?`) — are now global instead of per-pane. Cycling the sort order, or collapsing/expanding the shortcut legend, used to change only the pane you pressed the key in; every other task session's Tasks pane kept its old order and fold state, so the rail looked inconsistent across sessions. Both now ride the same `ui-prefs` daemon channel as theme/appearance: the toggle persists to `state.json` and the daemon fans it out live, re-sorting and re-folding the Tasks pane of every open session at once. The choices also survive pane respawns and relaunches — a freshly spawned Tasks pane opens in your last sort and fold state rather than resetting. Panes running without a daemon still toggle locally and converge on reconnect.
- 3d54b24: Editing `~/.kobe/settings/keybindings.yaml` now takes effect live across every session, instead of only on the next session rebuild. The daemon watches the keybindings file and pings a new `keybindings` channel on change; each open kobe pane re-reads the file and re-applies it onto its in-memory keymap from a clean slate (so a removed override correctly returns to its default, not the stale chord), and the Tasks-pane key legend re-renders to match. Binding behaviour updates without any extra nudge because the dispatcher already resolves chords on every keypress. Two boundaries are unchanged for now: the legend's built-in pane verbs (n/s/o/t/…) still display their default caps, and the tmux session-layer keys (`ctrl+t`, `ctrl+hjkl`, tab switching, detach) are bound on the tmux server at session build, so changing those still needs a rebuild to take effect. Panes running without a daemon keep their boot-time keybindings until relaunched.
- 1883c74: Fix the Ops pane growing to multiple GB of memory over long sessions. Every fs-watch refresh rebuilt the file tree with all-new row objects, destroying and recreating every row's renderables — and @opentui/core 0.2.4 retains a small amount of native memory per renderable create/destroy cycle, so a busy worktree (thousands of refreshes a day) leaked without bound. Refreshes whose git output is unchanged now suppress entirely, and changed refreshes reconcile by row identity so only rows that actually changed re-render.
- 0e23a57: The workspace layout now stays consistent across tasks instead of resetting on each switch. The Tasks rail width, the right-column width, and the file-tree/terminal split are each remembered as one shared global size: drag any of them to your liking in one task and it's captured when you switch away, then applied to every other task (and to newly created tasks and `Ctrl+T` chat tabs). Sizes persist for the life of the tmux server: quitting and relaunching kobe keeps them (quitting kobe only detaches — the tmux server and its task sessions keep running), while anything that tears the tmux server down (`kobe reset`, `kobe kill-sessions`, or a reboot) clears them back to the defaults. A user who never resizes the right column keeps today's default split untouched. The first task opened on launch now also matches that shared layout immediately, instead of showing a wider rail until the first switch.

## 0.7.17

### Patch Changes

- b4951d8: Customizable keybindings via `~/.kobe/settings/keybindings.yaml`. Override any rebindable chord per binding id (`chat.fork.new: ctrl+g`), with `darwin:` / `linux:` platform overlays and `null` to unbind; overrides apply to every kobe pane at launch, and the help dialog (F1) / status bar advertise the new chords automatically. Invalid or unsafe overrides (unknown ids, bare letters on global scope, `shift+letter` chords) are rejected with warnings instead of breaking input. The Tasks pane's f1/n/s/u/o/b/v verbs now route through the central keymap, so they follow overrides too. A new read-only Settings → Keybindings section shows the config path, applied overrides, and every load warning. Direction-multiplexed bindings (j/k navigation, `[`/`]` cyclers, ctrl+hjkl pane focus) and tmux-layer session keys stay fixed for now.
- 6a5376c: The daemon no longer freezes while git works: worktree operations (`git worktree add` on task open, remove, dirty checks, branch renames) used to run as synchronous subprocesses inside the daemon process, so materialising a worktree on a very large repo stalled every connected pane's RPCs and live updates for the duration. ExecHost's expensive operations (run/exists/readFile/readdir) are now async — the daemon keeps serving all clients while git churns in the background.
- f2905df: The Tasks pane's `── keys ──` legend is now collapsible: press `?` (or click the header) to fold the ~20-row shortcut list down to its header line and back; the preference persists across pane respawns. Move-mode hints always show. Also fixes host-level letter chords (n/s/u/o/b/v) firing while typing into the `/`-search box.
- 0e5a179: More "never block the UI" hardening: the sidebar's project-branch labels and the Ops pane's Create-PR prompt no longer run synchronous git on the render thread (both now go through an async background poller / async spawn with timeouts), and a CI guard test bans new synchronous subprocess calls from render paths.
- e8916a6: The deprecated outer monitor is removed. `kobe` now launches straight into the task session flow — there is no opentui shell in front of it anymore. The monitor's two surfaces go with it: the Live Preview (switching sessions inside tmux _is_ the preview, and the Tasks pane carries status badges) and the Cost Dashboard (dropped without a port). The `KOBE_OUTER_MONITOR=1` and `KOBE_NO_DAEMON=1` escape hatches are retired too — the daemon is the product, and `kobe doctor` / `kobe reset` cover its failure modes. Keymap rows only the monitor registered (`palette.open`, `app.copy_or_quit`, `focus.next`/`focus.prev`, `pane.resize-*`) are removed from the keybindings table; everything the in-session Tasks/Ops panes and the tmux layer register is unchanged.
- 5dbfa90: Fix the Tasks pane freezing on huge repos: the sidebar's per-row `+N −M` changes chip ran a synchronous `git status` for every row on every 2s tick, so a row pointing at a very large worktree (e.g. a 30GB repo, especially when listed in the Archives view) blocked the whole UI for the duration of each status walk. The chip now polls through an async background process with in-flight dedupe, a 4s timeout, and adaptive backoff (slow repos self-thin to at most one run per minute), and archived rows don't poll at all.
- 3312936: Fix a multi-process lost-update on `~/.config/kobe/state.json`: the TUI's settings store used to flush its whole in-memory snapshot back to disk, silently clobbering keys another kobe process (Tasks pane, CLI, settings window) wrote during the debounce window — e.g. an engine switched with `v` could revert after touching a setting elsewhere. All writers now go through a single state-store module that merges only their changed keys onto a fresh read, atomically.
- bf74733: Theme-matched tmux pane borders. The separator lines between the Tasks / engine / Ops panes were drawn with whatever tmux had — stock defaults, or a user tmux.conf border like oh-my-tmux's `#303030` gray — which disappears against dark kobe themes, losing the visible pane boundaries and the only focus cue. kobe now sets `pane-border-style` from the active theme's `border` slot and `pane-active-border-style` from the focus-accent slot (the same color the in-pane focus indicators use) on its own `-L kobe` socket, so borders stay legible under every bundled or user theme and the active pane is highlighted in the theme accent. Applied on launch and session build, re-applied when you switch themes in Settings — no session rebuild needed — and your real tmux server is never touched. Opt out with `"tmuxBorderTheme": "off"` in kobe's `state.json`, which releases only the options kobe wrote.
- fc22a70: tmux-layer session keys are now customizable from the same `~/.kobe/settings/keybindings.yaml`: `tmux.tab.new` (ctrl+t), `tmux.tab.prev`/`tmux.tab.next` (ctrl+[ / ctrl+]), `tmux.tab.close` (ctrl+w), `tmux.tab.rename` (f2), `tmux.tab.chooseEngine` (ctrl+shift+t), `tmux.detach` (ctrl+q), and `tmux.focus` (a positional 4-chord group, left/down/up/right, default ctrl+h/j/k/l). Overridden defaults are unbound on the kobe tmux server so old chords don't linger; `null` skips installing a binding. Guard rails reject `cmd+` chords (never reach tmux) and bare keys that would shadow typing in the engine/shell panes. The Tasks-pane footer legend, the tmux status-right hint, and the Settings → Keybindings report all render the resolved chords. Overrides apply when a session is (re)built.
- 880192f: Appearance changes now propagate live to every open kobe pane across all task sessions. Switching the theme (or toggling transparent background / picking a focus accent) in Settings used to restyle only the session you changed it in — the Tasks and Ops panes of every other task session kept the old look forever, because each pane read the persisted prefs once at boot. The daemon now watches `state.json` and pushes visual-pref changes on a new `ui-prefs` channel; every pane host applies them immediately, including user-installed themes added after a pane started. This also fixes a smaller drift: the new-task, quick-task, update, and file-preview pages now honor transparent background and focus accent too, not just the theme. Panes running without a daemon keep their boot-time appearance until restarted; on reconnect the latest prefs are replayed automatically.
- 05673b5: The web dashboard's server moved out of the daemon into a standalone bridge (`kobe-web/server`). `kobe web` now runs the HTTP/SSE server in its own process and talks to the daemon purely over the socket protocol as a `role: "gui"` subscriber — so a web bug can't take the daemon down, and the bridge survives `kobe daemon restart` by auto-reconnecting (the dashboard shows a brief "daemon down" instead of dying). Web dev gets the same isolation: `kobe-web`'s `bun run dev` runs the bridge under `bun --watch`, so editing bridge code hot-restarts it without touching the daemon or your tasks. The daemon-side `daemon.web.start` / `daemon.web.stop` RPCs are gone (protocol v3; an old `kobe web` against a new daemon gets a clear "unknown daemon request" error — rerun the new `kobe web` instead). On first launch the new `kobe web` SIGTERMs a previous daemon-hosted kobe-web holding the port; that old daemon shuts down cleanly and is respawned on the next kobe launch.

## 0.7.16

### Patch Changes

- 7cf626f: Add experimental SSH-backed remote projects, off by default behind Settings → Dev → Experimental → Remote projects. When enabled, register a project whose git worktrees and engine run on a remote host over SSH (`kobe add --remote --host … --user … --path … [--port N] [--key [path] | --password]`) — clicking it or creating a task materialises the worktree on the remote and launches the engine in a local tmux pane via SSH, while kobe, tmux, and the daemon stay local. The SSH password is held only in the macOS keychain, never in state, argv, or the pane command. Still in testing: a remote task's file/diff panes degrade for now, and it has not yet been exercised against a live host, so it stays dark until you opt in.

## 0.7.15

### Patch Changes

- 9cf549d: **Picking an engine with Ctrl+Shift+T now sets your default engine, and Settings shows it.** Choosing an engine for a new chat tab (Ctrl+Shift+T / `prefix T`) used to leave the default for _new tasks_ untouched; it now updates the one shared "default engine" reference (`lastSelectedVendor`) that the new-task dialog and quick-task already read. Settings → Engines surfaces that reference: the default engine's row is marked with a `●`, and pressing `d` on any engine row sets it as the default — so the same default is visible and settable from Settings or from Ctrl+Shift+T, kept in sync.
- 3eeb6b9: **Archiving now asks first, and custom engines no longer look frozen.** Pressing `a` to archive an active task now shows a confirm ("Archive … and stop its running session?") before it acts, so you can't lose a live engine session to a stray keystroke — archiving still stops the task's running session (an archived task shouldn't keep an engine subprocess burning resources), but the worktree, branch, and chat history stay on disk and the session is rebuilt when you unarchive. Un-archiving stays instant (no confirm). And a task running on a custom (user-added) engine, which kobe can't read activity for, now shows a neutral dim "no activity tracking" affordance instead of a perpetually-idle badge that looked like the task was stuck.
- b6901ac: **kobe is easier to learn and gives more feedback.** `F1` now opens the keyboard help from the normal (direct-tmux) flow — previously it only worked in a deprecated path, so the whole help screen was effectively invisible; the help now also lists the Tasks-pane and tmux-window chords. The footer key hints match the actual keys (lowercase `n`/`s`/`o`/`t` instead of misleading capitals), the `prefix F`/`prefix T` hints resolve and show your real tmux prefix (e.g. `⌃B F`), and the `⌃Q` hint reads `tasks→detach` to reflect its two-stage behavior. The Working/Archives tabs show a small `[/]` hint so the switch chord is discoverable, and the update chip advertises its `[u]` key. You also get feedback where there was none: cycling the engine with `v` confirms `Engine → … (applies on reopen)`, creating a task shows a brief `Creating task…`, pressing `u` when you're up to date says so, trying to create a task with no engine CLI installed warns you, and the Settings → Dev section points at `kobe doctor` / `kobe reset` for recovering a wedged daemon.
- 1844ecb: **A batch of "do what I expect" sidebar + task fixes.** Pressing `a` on a project (repo-root) row no longer silently archives the whole repo entry — archive, like delete, now leaves `main` rows alone. The sidebar stops lying about state: a task you've been chatting with for an hour no longer reads "backlog", and a rate-limited / errored / awaiting-permission task now shows the actual word ("rate limited" / "error" / "needs permission") in its row instead of a lone one-character glyph. Empty states are actionable ("No active tasks — press n or [+] to create one", plus an "a to unarchive" hint in Archives), and the footer legend calls `a` what it is (archive **and** unarchive). The `v` engine-cycle now reaches your custom engines (it walks the same detected + custom set the new-task dialog uses) instead of dropping you onto a built-in you can't cycle back from, and the branch/move keycaps dim on a `main` row where they don't apply. Finally, Tasks-pane actions that used to fail silently into a hidden log (no editor on PATH, worktree/create/rename/delete failures) now raise a visible red error toast — so "I pressed o and nothing happened" tells you to set `KOBE_OPEN_EDITOR`.
- e5cbfbf: **Custom engines and the engine panes are easier to live with.** Every engine/shell pane now shows a tiny dimmed hint of the escape hatches (`^h tasks  ^q detach  ^t tab`) on the tmux status line, so you're never stuck inside the engine pane not knowing how to get back to the task list or detach. The `Ctrl+T` / `prefix T` "new engine tab" prompt now accepts your registered custom engines (not just claude/codex/copilot) and, when you mistype an engine name, says so with a visible message instead of silently doing nothing. A custom engine whose launch command is wrong (a typo'd binary) now prints a clear "Engine exited (code N) — check Settings → Engines, press R to relaunch" banner in the pane instead of dropping you onto a bare shell that looks like nothing happened. And a custom engine added without a display name now shows a tidy title-cased label ("My Local Agent") instead of its raw `my-local-agent` slug.
- 5956c31: **Shortcuts now display as macOS key glyphs everywhere — including the tmux-prefix ones.** The footer, the F1 help, and the status bar all render chords the way a Mac user reads them at a glance — `⌃ Q`, `⌃⇧ T`, `⏎`, `⌃B F` — with a space between the modifier icons and the key. The two-step `prefix` chords show the prefix as a key cap then the key (`⌃B F` for "press your tmux prefix, then F"), and the help resolves your actual tmux prefix rather than guessing. `tab` stays the word `tab` (a glyph is overkill for it), and plain-letter chords keep their literal lowercase key (`n`, not `N`) so the legend is exactly what you type. A single `formatChord` helper now drives every shortcut display so they can't drift.
- cf86c30: **Project (repo) rows in the sidebar are now two-line cards, like tasks.** A project used to be a single line — `★ repo   ~/path` — while tasks were two-line cards, so the two read differently. A project now shows `★ repo` on line 1 and the repo root's **current branch** plus the `+N −M` uncommitted-change chip on line 2, exactly like a task. So at a glance you see which branch each repo root is on and whether it's dirty; the repo path moved to the hover tooltip (where task paths already live).

## 0.7.14

### Patch Changes

- d662af1: **Archived tasks no longer cost any daemon polling work.** The daemon's 4s auto-title loop has two passes — the task title pass and the ChatTab window-naming pass — and both used to iterate every task in the index, archived included. For each archived regular task the window-naming pass shelled out to `tmux list-windows` plus per-window option queries and transcript reads on every tick, so the cost grew with the size of your archive and never settled. Both passes now skip `archived` tasks before any disk/tmux work (matching the sidebar's `t.archived` split). Un-archiving a task re-includes it on the very next tick, so a placeholder-titled task you bring back still auto-names normally.
- f60f7a6: **Ctrl+Q is now two-stage: focus the Tasks pane first, detach second.** From the engine / Ops / shell pane, the first Ctrl+Q moves focus to the current window's Tasks pane instead of immediately dropping you back to the launching shell; pressing it again from the Tasks pane detaches as before. The check is the native `@kobe_role` pane tag (an `if-shell` in the tmux binding), so focusing Tasks costs no extra process. A one-step detach is still available via tmux's own `prefix d` / `ctrl+b d`.
- 80de572: **You can now add your own engine.** Settings → Engines gains a `+ Add engine` row: give it an id, a launch command (e.g. `aider --model sonnet`), and a display name, and it shows up in the new-task engine selector alongside Claude / Codex / Copilot. Picking it launches your command in the task pane. Custom engines are always offered (no binary probe — "you added it" counts), and `x` on a custom engine's row removes it (on a built-in, `x` still resets to default). Telemetry that needs a vendor-specific transcript format (auto-title, the activity badge, the cost dashboard) simply stays empty for a custom engine rather than mis-reading another engine's store — kobe drives the CLI, it just can't read a format it doesn't know. Under the hood the vendor id is now open: the daemon accepts any engine id, and a custom engine's command/name reuse the same per-engine state keys the built-ins use.
- 00123a0: **Removed the clickable `+ New task` footer from the task sidebar.** kobe is keyboard-first, and the same create-task action was already surfaced by the `n` chord and the ShortcutHints legend — the footer was the only mouse-style button in the rail and pure duplication. Creating a task is now `n` (or `prefix F`); the dead `onAddTask` sidebar prop and its wiring are gone too.
- 72dbeb2: **`enter` in the file tree now opens the file directly in nvim/vim** — a changed file (vs HEAD) opens in side-by-side `nvim -d` diff mode with the committed version read-only on the left and the live editable file on the right; an unchanged file opens for plain editing. The HEAD blob is materialised to a tmp file (the `sh -c` safe stand-in for `<(git show …)`) and removed on exit, touching neither your nvim config nor the repo. When no nvim/vim is installed it falls back to the built-in read-only opentui preview, so `enter` is never a dead key. The separate `e` (edit) key is removed — `enter` is the single open action.
- a2fcdba: Add a feedback channel that sends GitHub Discussions through `gh` into the repo's Feedback category. Settings now includes a Feedback section for quick in-app submissions, and `kobe feedback` supports scripted submissions with inline text or a body file.
- 74c2a2e: **The new-task engine selector now lists only the vendors you can actually run.** It used to always show claude / codex / copilot regardless of what was installed, so you could pick an engine whose CLI is missing. The dialog now renders only vendors whose CLI binary is detected on PATH (same probe the Settings → Accounts section uses; account login is not required — having the CLI installed is the only gate). `ctrl+e` cycles within the detected set and a persisted last-selected vendor that's no longer installed is clamped to a detected one. If nothing is detected (e.g. a PATH hiccup) the selector falls back to showing all vendors so task creation is never blocked.
- 1ee6f97: **`prefix F` quick-create is now prompt-first, and jumps you into the new task.** Instead of reusing the rename dialog (whose field literally read "title"), the quick chord opens a small composer whose **prompt** field is focused on open — type a prompt, hit enter, and the task is created with the prompt delivered as its first message. Engine and branch sit right there too (`tab` cycles prompt → engine → branch, `ctrl+e` switches engine) but default from the task you fired it in, so the fast path stays type-and-go. On submit it also switches you straight into the new task's session rather than leaving you on the old tab. (The full `n` dialog is unchanged for when you want to pick a different repo / clone / adopt.)
- 0ea9c58: **`prefix F` opens a dedicated quick-create page that defaults from the current task.** The quick chord no longer drops you into the full new-task dialog — it opens its own window that pre-fills the repo (the task you fired it in, falling back to your first saved repo), your last-selected engine (clamped to a detected one), and the repo's current branch, so you're not re-picking what you almost always want. If no repo can be resolved (a rare first-run case) it falls back to the full new-task dialog so creation is never a dead end.
- 61c543c: **Single-field dialogs now label their field correctly instead of always saying "title".** The reusable text-input dialog hard-coded its field label as `title` and its footer as `enter rename`, so every place that reused it — editing an engine's launch command, an engine display name, the custom editor command, the feedback body, renaming a branch, the new-engine flow — confusingly read "title". The dialog now takes a per-use `fieldLabel` / `submitLabel`, so the engine command edit reads `command`, the branch rename reads `branch`, the feedback body reads `body`, and so on. Genuine task renames still read `title`. Edits that mean "blank = default" (engine command/name, custom editor command) can now actually be cleared by submitting an empty value.
- a47e501: **Settings → Engines now lets you rename an engine and reset it to default.** Each engine row already let you override the launch command; you can now also give it a custom display name (`r` to rename) and, when you'd rather not touch a customised command at all, reset that engine's command **and** name back to the built-in default in one step (`x`). Reset simply clears the overrides — an engine with no overrides shows its default label and command tagged `(default)`. The launch command edit, the rename, and the reset all take effect on the next task you enter.
- 6bd65cb: **The task sidebar header gains a `[+]` new-task button, and the version now sits next to the KOBE name.** The brand header reads `KOBE  v0.x.x` on the left with a bold, clickable `[+]` button pushed to the right edge; it runs the same create flow as the `n` chord. (Last release removed the footer `+ New task`; this puts the affordance back, in the header.)
- 5ef3a45: Fix archive toggles so restoring a task from Archives does not tear down its tmux session, while archive/delete cleanup continues to switch away and clear active-task focus consistently.

## 0.7.13

### Patch Changes

- 0d6f049: Keep hook-driven completed-turn badges visible until the next engine activity event. A `turn-complete` hook now stays as the checkmark instead of expiring back to the neutral status circle on the daemon activity TTL.
- 90424dd: Add the local `kobe web` dashboard with task selection, independent vendor and terminal tabs, notes, worktree changes, centered file previews, and bundled Nerd Font terminal rendering. As of 2026-06-09, `kobe web` is an early experimental feature built for exploration and fun; it is not the primary kobe experience or a product commitment. The Web shell now has a task-search rail with project/worktree grouping, selected-task context in the top and bottom bars, and clearer no-task/no-worktree states for the workspace, Notes, and Changes surfaces. The production `kobe web` command also ships the built SPA and starts the Node PTY server alongside the daemon web transport, so terminal-backed tabs work outside the Vite dev launcher.
- 28f8f8a: kobe-created task worktrees now live under `~/.kobe/worktrees/<repo-key>/<slug>/` instead of a hidden directory inside the source repo, so users no longer need repo-level `.gitignore` entries for kobe runtime worktrees. Existing repo-local `.kobe/worktrees` and `.claude/worktrees` tasks remain recognized by listing, slug allocation, and daemon auto-adoption, so current task records keep working without migration.
- 533f8f2: Add explicit task sort modes to the TUI Tasks list and local web dashboard. Task lists now expose default/manual ordering separately from recent-use ordering, and entering or selecting a task touches its `updatedAt` timestamp so recent sorting reflects actual task usage.
- f5eae62: Add a Task overview tab to the local web dashboard right rail. The panel can rename tasks, change status/vendor, pin, ensure worktrees, copy the worktree path, and archive the selected task from the browser UI; the web terminal also reports detach reasons in plain text and the web package now typechecks with Bun globals.

## 0.7.12

### Patch Changes

- 1186dd3: Tasks pane can now reorder regular task rows in-place: press `Shift+M` on a task, use `j` / `k` to move it, and press `Enter` or `Esc` to leave move mode. The order is persisted through the daemon so every open Tasks pane follows the same list.

  Task activity now lives in the row's leading status slot: running turns use the animated spinner, while approval-needed, rate-limited, completed, and error states use icons in that same position instead of adding a trailing text chip.

## 0.7.11

### Patch Changes

- b63ab67: Auto-adopt a worktree as a task the MOMENT it's created, no engine session required. 0.7.10 made external-worktree sync fire on `SessionStart` — so a worktree you spun up (a manual `git worktree add`, an agent creating one for a side task) only appeared in the sidebar once an engine actually started inside it. Now kobe also installs a global `PostToolUse` hook scoped to the `Bash` tool: the instant a `git worktree add` runs in any Claude session, the new worktree is adopted as a task and shows in the sidebar with no running session. This is the creation-time complement to the session-start path; both stay in place. Crucially it does NOT reintroduce the 0.7.10 footgun — `WorktreeCreate` was a VCS _provider_ hook whose mere presence broke `claude --worktree`, whereas `PostToolUse` is a pure observer fired AFTER the tool, so its presence never changes git or `--worktree` behaviour. The hook no-ops fast for any non-worktree command (and never spawns the daemon), adoption is bounded to repos kobe already tracks, and re-firing is idempotent — so a transient agent isolation worktree (created by Claude Code's own machinery, not a model-issued `git worktree add`) never floods the sidebar.

## 0.7.10

### Patch Changes

- fe06c31: Stop installing a global `WorktreeCreate` hook — it broke `claude --worktree` / `EnterWorktree` in every repo. `WorktreeCreate` is a VCS _provider_ hook: its mere presence makes Claude Code delegate worktree creation to the hook and skip the native git path, and kobe's hook only observed (returned no path), so Claude failed with "WorktreeCreate hook failed: hook succeeded but returned no worktree path." kobe now removes that hook on launch (merge-safe; your own WorktreeCreate hooks are preserved) and `kobe hook setup` is a deprecated cleanup-only no-op. External-worktree sync is reborn correctly on the daemon: a session that starts (SessionStart) in an unadopted worktree under a repo kobe already tracks is auto-adopted as a task — no hook, no footgun. Manual adoption (New Task dialog / `kobe adopt`) is unchanged.

## 0.7.9

### Patch Changes

- 5fd1ad6: Move engine activity hooks from per-task worktree installs to a single GLOBAL hook in `~/.claude/settings.json`. The per-task approach (writing `.claude/settings.local.json` into each worktree, baking the task id) had to fire at exactly the right moment, only took effect after entering a task, never reached an already-running engine, and could leak into a project's real repo root. Now one merge-safe block installs on launch and makes EVERY Claude session report `kobe hook <verb>` carrying its `cwd`; the daemon maps that cwd to a task by worktree path. Every existing task lights up at once — no per-worktree install, no enter-to-arm, no repo-root pollution. The hook no-ops fast (and never spawns the daemon) when the cwd isn't a kobe task.

## 0.7.8

### Patch Changes

- bb67300: Don't install per-task engine hooks into a `main` project's real repo root. Moving the hook install to `ensureSession` (so existing tasks get hooks on enter) dropped the old `kind === "main"` guard, so entering a project (whose worktree IS the repo root) wrote kobe's hooks into the real repo's `.claude/settings.local.json` — which then fired for EVERY Claude Code session in that repo, including ones kobe never launched. The install is now gated on the worktree being a kobe-managed one (under `.claude/worktrees/`), so a project's repo root is never touched; real task worktrees are unaffected.
- f0d928e: Keep the Tasks pane glyph-to-name spacing stable when the sidebar is squeezed.

## 0.7.7

### Patch Changes

- b17d99a: Two fixes.

  - **Per-task activity hooks now actually install for existing tasks.** They were only written on the worktree-CREATE path (`ensureWorktree`), but entering an already-materialized task skips `ensureWorktree` — so every pre-existing task never got the Claude Code hooks and the event-driven badges silently did nothing for them. The install moved to `ensureSession` (the single point every session build/reuse/rebuild passes through), so the hooks land on disk on every enter. A task whose engine is already running picks them up on its next engine launch (a rebuild, a vendor switch, or a new Ctrl+T chat-tab).

  - **The file-tree `e` editor now follows the standard `$VISUAL` / `$EDITOR`.** The default was a hardcoded `vim` that ignored your environment entirely. The new default kind is `auto`: it honours `$VISUAL` / `$EDITOR`, and if neither is set, auto-detects the first installed of nvim → vim → emacs → nano. `nvim` and `emacs` are now explicit choices too (alongside vim / nano / custom), all selectable from Settings. (Note: `e` opens the editor; `enter` still opens kobe's read-only preview — those are deliberately separate.)

## 0.7.6

### Patch Changes

- a47ded9: External worktree sync is now ON by default. kobe ensures the global `WorktreeCreate` hook is installed on launch, so an external `claude --worktree` syncs into kobe as a task out of the box — no `kobe hook setup` step needed. It's idempotent (skips the write when already in place, so it never churns your `~/.claude/settings.json`) and honours an existing scope choice. Turn it off any time with `kobe hook setup --off`, or scope it to one repo with `--repo <path>`.

## 0.7.5

### Patch Changes

- a3f0ee5: Warn when the running daemon is a stale build, and harden the new hook paths.

  - **Version-skew banner.** After `npm i -g @sma1lboy/kobe@latest`, Bun's lack of hot-reload means the already-running daemon keeps executing the OLD code until `kobe daemon restart` (and panes until `kobe reload`) — silently masking the upgrade. The wire-protocol check only catches a breaking change, so a normal patch upgrade slipped through. Now the daemon advertises its build version on `hello` / `daemon.status`, and the Tasks pane shows a non-fatal top banner — `⚠ DAEMON OUT OF DATE … run \`kobe daemon restart\` then \`kobe reload\``— that auto-hides once the daemon matches again.`kobe doctor` reports the skew too.
  - **Hardening (from an adversarial review of the hook features):** `adoptWorktree` now serializes concurrent adopts of the same worktree path (a per-path lock) so two simultaneous WorktreeCreate hooks can't create duplicate tasks; the per-task hook install's `.git/info/exclude` write is guarded by a per-process set so the backfill path no longer re-spawns `git` on every task enter (and can't double-append); `kobe hook setup` persists the resolved settings path and cleans the previous location when you switch scope or run `--off`, so no orphaned hook is left behind; deleting a task now publishes an explicit `idle` so a reused task id can't inherit a stale activity badge.

## 0.7.4

### Patch Changes

- 6e63922: Event-driven task state from engine hooks (Claude Code) — replacing the polling guesswork with real signals.

  kobe now installs Claude Code hooks into each task's worktree so the engine reports what it's actually doing — turn started/finished, rate-limited, or waiting on a permission prompt — straight to the daemon, which folds it into a per-task activity state and pushes it to the sidebar. Task rows show a live `working` spinner while a turn runs, and a `done` / `limited` / `approve?` / `error` chip otherwise, instead of inferring state by polling the tmux pane. The whole mechanism sits behind a neutral `EngineHookAdapter` seam (Claude is the first implementation; the daemon, CLI, and TUI never name a vendor), so Codex/Copilot can plug into the same contract later. The hooks are written to the worktree's `.claude/settings.local.json` and hidden from git via `.git/info/exclude` so they never pollute a task's diff, and they only own the events kobe drives — a user's own hooks are preserved. The polling turn-detector stays as a fallback. Internal `kobe hook <verb>` command (fired by the hooks) never spawns the daemon and always exits 0, so it can't keep an idle daemon alive or fail an engine turn.

- 2dad4b4: Sync external `claude --worktree` worktrees into kobe as tasks.

  When Claude Code creates a worktree OUTSIDE kobe (`claude --worktree`), kobe can now adopt it as a task automatically so it shows up in the Tasks list with its diff — no conversation required; you can open a chat in it later. Opt-in via `kobe hook setup` (writes a `WorktreeCreate` hook into `~/.claude/settings.json` global by default, or `--repo <path>` for one repo, or `--off` to remove); the hook is tagged + merge-safe so it never clobbers your own hooks. Adoption is idempotent — a worktree kobe already tracks (including ones kobe created itself) is a no-op. The `kobe hook worktree-created` callback never spawns the daemon and always exits 0, so a non-zero exit can't fail Claude's worktree creation. Per-task activity hooks now also backfill onto worktrees created before this version (installed on the next time the task is entered), so existing tasks light up too.

## 0.7.3

### Patch Changes

- 178b019: Make `kobe api` a self-describing, full-lifecycle control surface; add `kobe skill install`.

  - **`kobe api` — full task CRUD.** The old six verbs become eighteen: alongside a richer `add` (title, branch, base-branch, vendor, status, pin, optional first prompt), `fan-out`, `send`, `get-task`, `collect`, and `list`, the API now exposes the whole task lifecycle the daemon already supported — `rename`, `set-branch`, `set-vendor`, `set-status`, `archive`, `pin`, `set-active`, `ensure-worktree`, `delete`, `adopt`, `discover-adoptable`. A declarative verb table is the single source of truth driving help, schema, and flag validation (required / enum / unknown-flag rejection). `spawn-task` stays as an `add` alias.

  - **Leveled, context-friendly exploration.** `kobe api schema` returns a COMPACT index (groups + verb summaries, no flags) so an agent surveys the surface cheaply, then drills in with `kobe api schema --verb <name>` (one verb's full detail), `--group <g>`, or `--all` for the complete spec. Every verb also has `kobe api <verb> --help`.

  - **`kobe skill install`.** A convenience wrapper that runs the agent-skills flow (`npx skills add Sma1lboy/kobe …`) for you, plus `kobe skill status` and `kobe skill command`. The skill is version-stamped now: when you upgrade kobe past the skill you installed, `kobe doctor` / `kobe skill status` / a one-time startup hint flag it as out of date and prompt a refresh. The kobe skill itself is rewritten to document the expanded API and the leveled `kobe api schema` exploration.

## 0.7.2

### Patch Changes

- 1f8fb9a: Converge the Tasks-pane create/delete sync drift, add `kobe reload`, and add a client log.

  - **Sync fix (no more frozen task lists).** A Tasks pane that subscribed to the daemon at boot used to FREEZE its list when that daemon later went away — the refcounted lazy-shutdown idle-stops the daemon 3s after the last GUI quits, while the pane lives on with the tmux session, and the client had no auto-reconnect and no fallback. Now a `role: "pane"` orchestrator auto-reconnects on socket close (a NON-spawning retry, so it never resurrects an idle-stopped daemon and breaks lazy-shutdown), and the Tasks pane always keeps a `tasks.json` backstop poll that takes over the instant the daemon goes offline. The daemon's snapshot replays on re-subscribe, so the pane re-syncs automatically. A malformed daemon frame can no longer silently kill a client's event delivery (the JSON parse is now guarded).

  - **`kobe reload`.** Restarts the in-tmux Tasks + Ops panes across every live session in place (reusing the same `respawn-pane` heal the post-Settings refresh uses) so kobe TUI-layer code changes load WITHOUT `kobe reset` — the engine (claude) panes and your running turns are never touched.

  - **Client log.** Panes run inside an opentui alternate-screen, so their stdout was invisible — which is why the sync drift went undiagnosed for so long. Client-side processes now append tagged, timestamped connection-lifecycle lines (subscribe / disconnect / reconnect / fallback) to `<home>/.kobe/client.log`, and the daemon logs the matching socket churn (subscribe/disconnect with role + counts, idle-arm/stop) to `daemon.log`.

- 337b34a: Fix a project row stuck showing the `working` chip when nothing is running. A `main` (project-root) task has no session lifecycle that maintains its status, so an old auto-done flip — revived by the `done → in_progress` self-heal on every load — left the project permanently `in_progress`, which the Tasks pane reads as "working". Project rows now ignore the persisted-status fallback (only a genuinely live engine handle makes a project read as working), and the on-load self-heal resets any `main` row to a neutral `backlog` instead of `in_progress`.

## 0.7.1

### Patch Changes

- f98c721: kobe-home is now a real home, not a dead end. Deleting the task you're in (when no other task is left) used to drop you on a bare shell that printed "No active task" with no sidebar and no way to make a new one. Now you land on a home that keeps the product's layout frame: the same fixed-width Tasks rail a real session carries on its left (focused, so `n` to create and arrows to pick work immediately) next to a "No task selected" welcome pane. Pick or create a task and you switch straight into its full session.

  The task-bound panes (engine chat, file tree, Ops) are intentionally omitted from home — there's no worktree or engine to populate them until a task is entered. They come back the moment you switch into a task.

  The same home backs the zero-task launch case: running `kobe` with no tasks at all used to error out with "no task available to enter" and exit to your shell. It now parks you on this home instead, so a fresh checkout (or one where you just deleted everything) lands somewhere you can actually start work.

  Deleting or archiving the task you're in also keeps the sidebar honest. The flow switched the tmux client to the next task (so the chat pane was right) but never moved the shared active-task focus, so every Tasks pane kept highlighting the task you'd just removed. It now sets the active task to wherever the client landed (or clears it when you fall through to kobe-home), so the sidebar highlight always matches the chat pane — the same `setActiveTask` step `switchTo` already does on a normal switch.

  Mechanics: `ensureFallbackSession` builds a welcome main pane plus a `kobe tasks` rail (`split-window -hb` at `TASKS_PANE_WIDTH`, keep-alive wrapped, cwd anchored to a directory that always exists) and tags the session `@kobe_home=tasks`. A legacy bare-shell kobe-home from an older build is rebuilt in place rather than reused, since tmux sessions outlive a kobe relaunch. `tui/direct.ts` attaches the home session on the zero-task path instead of bailing.

- 2338989: Multi-client window sizing: enable tmux `aggressive-resize` so each chat-tab window tracks the client actually viewing it. Before, a small terminal attached anywhere in a task session dragged every window — including the one a larger terminal was looking at — down to the smallest client's size, which then squeezed the fixed-width Tasks pane against a too-narrow window. Now each window sizes to its own current viewer. (Two clients on the _same_ window still share one grid and the larger is letterboxed — a tmux limit that needs per-client sessions to lift.)
- f98c721: Opening a task no longer snaps the spawned session's Tasks pane highlight to the first row. Before, every freshly built task session showed its sidebar cursor on the top task instead of the one you opened.

  Root cause was two effects fighting at mount: the sidebar's "reset cursor to 0 on view switch" effect ran once at mount (it wasn't deferred), clobbering the cursor that the select-from-`selectedId` effect had just positioned on the opened task. A fresh pane mounts on every new task session, so the reset always won. Deferring the view-switch reset so it only fires on an actual later view change fixes it; the initial cursor is owned by the selectedId-sync effect.

  Also hardened the related path: a spawned Tasks pane now ignores the daemon's replayed `active-task` value (which, on subscribe, is still the pre-switch task because `setActiveTask` is published after `switch-client`) until the channel confirms its own task — so the highlight no longer flashes the previously-entered task before settling.

- f98c721: Deleting a task no longer crashes the panes of the session you're in. Before, deleting the active task could drop the Ops pane (and the file tree) to a bare shell with a `posix_spawn 'tmux'` stack trace, leaving the GUI stuck in a half-cleaned state.

  Root cause: every Tasks/Ops pane runs with its task's worktree as the process cwd. Deleting the task removes that worktree, but kobe kills the tmux session a beat later — and the kobe-owned panes inside it keep polling on their timers in between. Once the worktree is gone the kernel can't resolve the inherited cwd, so `Bun.spawn` fails with `posix_spawn` ENOENT _before the command runs_ — even though tmux is on PATH. That throw landed in a pane's polling loop, and a pane process has no crash net (those are daemon-only), so the whole pane crashed to a shell.

  Fixed in two layers:

  - **The tmux spawn helpers tolerate a deleted cwd** (`tmux/client.ts`): every `Bun.spawn` is now anchored to a directory that always exists (`$HOME`) instead of inheriting the pane's worktree cwd, and a spawn failure degrades to a non-zero result instead of throwing. This protects _all_ in-session pane spawns — the Ops activity/turn polls, the file tree's git polling, `send-keys`, etc. — not just one call site. `currentSessionName` keeps its documented "returns null when tmux can't answer" contract.
  - **The Ops pane's poll loops swallow transient teardown errors** (`tui/ops/host.tsx`): the activity and turn-detector polls wrap their bodies so a failure during the delete→kill window degrades to a quiet no-op and the next tick retries, instead of becoming an unhandled rejection.

## 0.7.0

### Minor Changes

- 0fde588: File tree: `e` opens the highlighted file in your editor. `enter` stays the read-only preview/diff; the new `e` key opens the file in a fresh tmux window running your editor, and the window closes back to kobe when you quit it. Pick the editor under Settings → General → Editor: `vim`, `nano`, or a `custom` command (e.g. `code -w`, `subl -w`, `emacsclient`; use `{file}` to place the path, otherwise it's appended). An empty custom command falls back to `$VISUAL`/`$EDITOR`. If the chosen editor isn't installed, `e` falls back to the preview so it's never a dead key. The file pane footer shows `↵ preview · e edit`.

### Patch Changes

- 2722ccd: File-tree editor (`e`) follow-up fixes:

  - **Custom command was un-typeable on the standalone Settings page** — the dialog's `j/k/l/h/t` navigation kept firing under the open text input and swallowed those letters (you couldn't type the `l` in `{file}`). The dialog now suspends its own key bindings while a sub-dialog is open.
  - **A custom command typed while the kind was still `vim` was silently ignored** — setting a non-empty custom command now auto-switches the editor kind to `custom` so it actually takes effect.
  - **The editor kind row was unlabelled** (`< vim >`), easy to miss above the custom-command row — it now reads `editor: < vim >  (enter to change)`.
  - **The standalone Settings page jumbled its text** when the content was taller than the window — the page now scrolls instead of compressing the rows.
  - The editor opens in a tmux window named after the **file** being edited (matching the preview window) so several open files are easy to tell apart.

- 6b41216: Stop the file/changes panes from racing the engine for `.git/index.lock`.

  The sidebar's per-row `+N −M` chip polls `git status` every 2s, and the file-tree and Ops panes run `git status`/`git diff` on demand. Those commands aren't purely read-only — git opportunistically rewrites `.git/index`'s stat cache, which takes `.git/index.lock`. Running on a poll across every worktree (and across multiple ChatTab pane processes) meant they could collide with the worktree's own engine `git commit`/`git add`, surfacing as intermittent `fatal: Unable to create '.git/index.lock': File exists` errors.

  All pane-side inspection git calls now run with `GIT_OPTIONAL_LOCKS=0`, so they inspect without writing the index or taking the lock. Real writes (engine commits, worktree create/remove, branch rename) are unaffected and still lock as they should.

- 5b648c1: Fix Settings transparent-background changes so they persist and apply after closing the Settings page. The Settings page now flushes UI state before exit and refreshes only kobe-owned Tasks/Ops panes when visual preferences changed, leaving engine and shell panes untouched.
- d07b2df: Redesign the Tasks pane (sidebar) and tidy the file-changes pane. Tasks now
  render as compact two-line cards with a left accent bar + subtle tint for the
  cursor (replacing the heavy full-row fill), split into two labelled sections —
  `PROJECTS` (repo roots, with their dir) on top and `TASKS` (worktrees) below.
  The `working` chip + animated spinner now surface a task's in-progress state.
  Panes sit flush to their tmux edges (horizontal padding removed), the footer
  key legend right-aligns its descriptions in a capped column, and Changes-tab
  paths tail-truncate so the filename always shows. The version/update chip moved
  up into the new `KOBE` brand header; the footer `system` section is gone. The
  file-changes pane's row selection now matches the sidebar — a left accent bar
  - subtle tint instead of a solid fill.

## 0.6.10

### Patch Changes

- 174b27d: fix: daemon now shuts down on quit even with many ChatTab windows open

  The refcounted lazy-shutdown counted every subscribed client, including the
  in-tmux helper panes (Tasks pane, Ops, settings/new-task windows) that each
  ChatTab window spawns. Those panes persist with the tmux session after the user
  quits kobe, so with several ChatTabs open the subscriber count never reached
  zero and the daemon stayed alive forever. `subscribe` now carries a role: only
  the front-end attach (`role: "gui"` — `kobe` parked on `tmux attach`) holds the
  daemon alive; helper panes subscribe as `role: "pane"` for live data without
  keeping it running. Quitting the last GUI now reliably idle-stops the daemon.

<!-- Versions below are generated by Changesets from `.changeset/*.md`. Don't hand-edit pending notes here — add a changeset instead (`bun run changeset`). See docs/RELEASING.md for the flow + the no-soft-wraps style rule. -->

## [0.6.9] - 2026-05-31

### Changed

- **A new task auto-names itself while you're still in it** — previously a task kept its `(new task)` placeholder for the whole session and only picked up a title from your first prompt once you detached back to the task list. The daemon now watches each still-unnamed task's engine transcript and renames it from your first message a few seconds after you send it, so the sidebar updates live without leaving the session. It only ever replaces the placeholder, so a manual rename is never overwritten; the detach-time naming stays as a fallback when no daemon is running.
- **The Tasks pane fills its tmux pane and adapts to its width** — the task list now stretches to 100% of the pane as you drag the tmux split, instead of staying pinned to a narrow rail. On a narrow pane the secondary columns step out of the way so the task name always stays readable: the branch label drops first, then the uncommitted-changes chip, and the title truncates with an ellipsis only when it has to. Widen the pane and they come back.
- **Hover a task row to see its full details** — a tooltip pops up showing the complete task title, branch, and worktree path, so a name or branch that had to be shortened on a narrow rail is still one hover away.
- Make dialog backdrops and dialog cards transparent-mode aware so modals keep more of the tmux context visible behind them.

## [0.6.8] - 2026-05-31

### Fixed

- **Archive/delete from an active task session no longer drops to a black screen** — archiving or deleting the task whose tmux session you are currently inside now switches the tmux client to the next non-archived task (if one exists) before killing the session; when no other tasks are available, a `kobe-home` placeholder session is created and switched to instead, keeping the terminal alive.

## [0.6.7] - 2026-05-31

### Added

- **`kobe --help` shows the version** — the help / usage output now leads with `kobe X.Y.Z`, so you can see which version you're on without a separate `kobe --version`. The unknown-command usage dump shows it too.

### Changed

- **Update opens as a tmux-native page** — clicking the Tasks pane update status (or pressing `u` while the Tasks pane is focused) now opens a dedicated tmux window with the current/latest versions, release notes, a browser jump to the GitHub release, and an in-window updater handoff instead of relying on the deprecated outer TUI update dialog or cramped footer copy.

## [0.6.6] - 2026-05-31

### Added

- **Per-repo init script + first prompt** — each repo can now define setup that runs automatically for every worktree, so a new task is ready to work without manual steps. Two sources, repo files winning per field: commit `.kobe/init.sh` (runs in the worktree right before the engine starts, in the same shell so its `export`s reach the engine) and `.kobe/init-prompt.md` (pasted as the engine's first message once it's ready); or set a per-user fallback for a repo that ships neither via `kobe repo set <path> --init-script(-file) … --init-prompt(-file) …` (inspect with `kobe repo show`, clear with `kobe repo unset`). The init script runs once per worktree (a marker under `~/.kobe/` gates re-runs, and it's only marked done if the script succeeds — a failed `pnpm install` retries next launch); the first prompt is delivered only when a session is freshly created, never on re-attach. `kobe api spawn-task/send --prompt` still runs the init script but delivers your explicit prompt instead of the repo's.
- **`kobe add` folds in a repo's existing worktrees** — saving a repo with `kobe add <path>` now also scans that repo's git worktrees and imports the ones not yet linked to a task, so an existing multi-worktree checkout shows up in kobe without a separate adopt step. The scan runs in-process (`git worktree list` + a `tasks.json` read) so a plain repo with no extra worktrees stays instant and `kobe add` never boots a daemon as a side effect; when there are worktrees to import, a running daemon takes the writes over RPC (a live TUI updates) and an in-process write is used otherwise (KOB-256).
- **kobe detects the agent skill and nudges you to install it** — `kobe doctor` now reports whether the kobe agent skill (which teaches Claude Code to drive `kobe api`) is installed, and prints the `npx skills add …` command when it isn't. On startup, kobe shows the same install hint once if the skill is missing. Checks both the user (`~/.claude/skills/kobe/SKILL.md`) and project locations.
- **Settings and New Task can open as their own full-window page** — a new "Settings page" preference (Settings → General) chooses where the full dialogs open: ChatTab (the default) opens Settings and the new-task flow as a dedicated page in a new tmux tab alongside your engine tabs, closing with `q` / `esc` to return to the previous tab; Task panel keeps the original in-pane overlay inside the left Tasks pane. Pick the surface with two explicit checkboxes. Simple archive/delete confirmations stay as in-pane dialogs either way.

### Changed

- **Adoptable worktrees are ordered most-recently-active first** — the `kobe adopt` listing and the New Task → Adopt Worktree tab now sort discovered worktrees by their HEAD commit time (descending) instead of git's enumeration order, so the worktree you last touched leads the list (KOB-256).
- **The daemon shuts down on its own once you close the last kobe window** — the background daemon's lifetime is now tied to how many kobe TUIs are attached: it starts with the first window, is shared by all of them, and stops itself a few seconds after the last one closes (tunable via `KOBE_DAEMON_IDLE_GRACE_MS`, default 3s), so it no longer lingers forever after you quit. Your tmux task sessions are never touched by this — they survive the daemon and are picked back up next launch; only `kobe reset` / `kobe kill-sessions` tear sessions down.

### Removed

- **The per-TUI "single" daemon mode is gone** — kobe now always runs against the one shared daemon, so the `--single` / `--daemon` flags and the `KOBE_DAEMON_MODE` env var no longer exist (a bare `kobe` already did the right thing). Single mode was a v0.5 holdover from before the daemon was reference-counted; now that the shared daemon self-stops once the last window closes, a private per-window daemon buys nothing. No action needed unless a script passed `--single`/`--daemon` explicitly — drop the flag.

## [0.6.5] - 2026-05-30

### Added

- **`kobe api` returns for shell-driven fan-out** — agents can spawn and drive parallel tasks from a shell again, re-architected for v0.6's tmux model. Six verbs: `spawn-task` (create a task + worktree, and with `--prompt` start the engine and deliver the prompt); `fan-out --count N` / `--agents claude:2,codex:1` (spawn many of one prompt in a call, capped at 10); `send [--task-id ID] --prompt …` (paste a follow-up into a task's engine pane via tmux bracketed paste — multi-line stays one turn — defaulting to the active task); `get-task` / `list` (read task state); and `collect --task-ids … | --repo …` (read-only aggregation snapshot with per-task branch, live-session flag, and uncommitted change counts for comparing attempts). Output is one JSON object on stdout (errors are JSON on stderr); the daemon auto-starts.

### Changed

- **Unknown commands and `--help` print usage instead of launching the TUI** — a typo like `kobe statsu` now prints the command list and exits non-zero rather than silently opening the project. `kobe help` / `--help` / `-h` show usage, `kobe --version` / `-v` print the version, and a bare `kobe` still opens the TUI.
- **The daemon is more resilient and upgrade-friendly** — it now self-heals a wedged daemon (one whose socket accepts connections but never answers): the client probes `hello` with a short timeout and, if there's no reply, kills the stuck process before respawning instead of hanging or racing a second daemon onto the same task index. The version handshake negotiates a compatibility range (LSP-style) rather than requiring an exact match, so a newer daemon keeps serving a slightly-older TUI across an upgrade. The daemon also owns the npm update check now, polling once and pushing it to every Tasks pane instead of each pane checking the registry itself — and when an update is available the Tasks pane footer shows a `run: kobe update` hint so it's actionable on the tmux-native path.

## [0.6.4] - 2026-05-29

### Changed

- **Tasks pane key hints and docs match the tmux-native flow** — the in-session key legend now includes Working/Archives view switching, ChatTab rename, engine-picker fallback, and quick-create prefix chords; README and keybinding docs now describe direct-tmux startup instead of the deprecated outer monitor flow.
- **Existing tmux sessions self-heal kobe-owned panes after an update** — entering a healthy task session now checks the Tasks/Ops pane version tags and respawns only stale `kobe tasks` / `kobe ops` panes in place, leaving engine panes, shell panes, and ChatTab windows alive. `kobe reset` remains a runtime recovery fallback instead of the normal way to pick up new Tasks/Ops features after upgrading.

## [0.6.3] - 2026-05-29

### Added

- **Direct-tmux Tasks pane shows update status** — the in-session Tasks pane now has a compact `system` footer above the key legend, showing the current kobe version normally, `latest` when npm confirms it is current, and a warning-colored `vX.Y.Z available` when a newer patch is published. This keeps update detection visible after the legacy outer opentui monitor was deprecated.

## [0.6.2] - 2026-05-29

### Added

- **`kobe doctor` + `kobe reset` — recover a wedged install without a dev checkout** — the packaged build now has a first-class answer to "the daemon died / wedged, how do I reset?" that the dev-only `bun run dev:sandbox:reset` never gave end users. `kobe doctor` is a read-only health check: it reports whether the daemon is running / wedged (process alive but not answering) / stale (pidfile points at a dead pid) / not running, tails `daemon.log` when it's down so you can see why it died, counts kobe tmux sessions, and lists the presence + size of `tasks.json` / `state.json` / `daemon.log` — it never kills or deletes anything, just diagnoses and recommends. `kobe reset [--hard] [--yes]` is the production equivalent of the sandbox reset: it stops the daemon (graceful `daemon.stop` → SIGTERM → SIGKILL, the same escalation `kobe daemon restart` uses), removes its socket + pidfile, and kills every kobe tmux session in one shot; `--hard` additionally wipes the task index and UI state. It NEVER touches your git worktrees or anything under `.claude/worktrees/`, prompts for y/N confirmation on a terminal (skip with `--yes`), and does not respawn the daemon — relaunch kobe for a fresh one (KOB-258).
- **Adopt existing git worktrees as tasks** — kobe can now pick up worktrees that already exist on disk (including ones you made yourself with `git worktree add`, outside `.claude/worktrees/`) instead of only ones it created. New `kobe adopt [glob] [--repo <path>] [--vendor <v>] [--yes]` CLI: run it to list a repo's adoptable worktrees (those not already a task), pass a path glob to select a batch, and `--yes` to import them — each becomes a task pointing at the existing worktree + its branch, with no new checkout. The New Task dialog gains an **Adopt Worktree** tab (in both the outer monitor and the in-session Tasks pane): it lists the same candidates with a path-glob filter, space/click to multi-select (Ctrl+A = all), and Create to import. Discovery reads `git worktree list` and de-dupes against existing tasks; adoption goes through the daemon so every surface updates live (KOB-256).
- **ChatTab window switching gets no-prefix tmux shortcuts** — inside a task Handover, Ctrl+[ moves to the previous tmux ChatTab window and Ctrl+] moves to the next, matching the old bracket-pair tab vocabulary without bringing back the stale self-rendered chat surface (KOB-257).
- **ChatTab close returns as Ctrl+W in tmux** — inside a task Handover, Ctrl+W closes the current tmux ChatTab window when another window remains, restoring the v0.5 close-tab affordance while protecting the final window from accidentally killing the whole Task session.
- **More v0.5 productivity chords return in tmux-native form** — F2 renames the current tmux ChatTab window, the in-session Tasks pane can open the selected task's worktree with `o`, and the Ops pane's Changes tab now shows a slim `[P] create PR` action row that injects the PR prompt into the engine pane instead of using an outer-monitor button.
- **Engine-select ChatTab creation** — Ctrl+T still opens a fast same-engine ChatTab, while Ctrl+Shift+T (plus prefix `T` as a terminal-safe fallback) prompts for `claude` / `codex` / `copilot` before opening the new tmux window; that choice becomes the task/session default for later Ctrl+T tabs.
- **Tasks pane owns the missing outer-monitor actions** — with the legacy opentui monitor deprecated, the in-session Tasks pane now supports `s` settings, `a` archive, and `d` delete with the same confirmations and dirty-worktree guard as before; archive/delete also kill the task's cached tmux session when one exists.
- **ChatTab labels show engine turn status** — tmux window tabs now read a detector-owned `@kobe_tab_state` option (`●` running, `✓` done, `○` idle, `?` unknown). The Ops pane updates it with a Warp-style lifecycle detector: vendor-owned transcript completion markers plus pane quiescence, instead of tmux's coarse activity flag.

### Changed

- **`kobe` now opens directly into tmux** — the opentui outer monitor is deprecated and kept behind `KOBE_OUTER_MONITOR=1`; normal startup selects the last active task, ensures its tmux workspace, and attaches immediately, with task switching handled by the in-session Tasks pane.
- **The default task/sidebar panel is now 32 cells wide** — direct-tmux startup makes the Tasks pane the primary navigator, so new installs and invalid saved widths start wide enough for readable task titles instead of the old 42-cell history rail (KOB-259).
- **Tmux handover window setup is batched** — creating the first task window and new Ctrl+T ChatTabs now performs session tags, pane splits, pane role tags, and server keybindings through far fewer tmux subprocess round trips, making the kobe-level window/init path feel less sticky.
- **The direct-tmux Tasks pane is wide enough to read** — the in-session Tasks pane now uses a 32-cell fixed width and heals existing 12-cell sessions on next enter, so Working/Archives, task titles, and shortcut hints are not clipped.
- **The first direct-tmux window uses the real terminal size** — clean sandbox/prod startup now passes the current TTY dimensions to detached `tmux new-session`, so the initial window has the same column widths as later Ctrl+T ChatTabs instead of being split at tmux's default 80-column size and stretched on attach.

## [0.6.1] - 2026-05-29

First stable release on top of the 0.6 product reshape — promotes the `0.6.1-experimental.0` prerelease to `latest`. Bundles the post-0.6.0 Tasks-pane / engine / event-bus work (KOB-244, 246, 247, 248, 232, 245), GitHub Copilot as a third engine plus the Accounts view (KOB-249), the inner Tasks-pane width trim (KOB-253), the Ops-pane new-activity badge (KOB-254), and the Ops file-watcher fix (KOB-255).

### Fixed

- **The Ops pane file watcher actually starts in task sessions** — the v0.6 Ops pane reused FileTree's opt-in watcher, but the tmux launch command never set the opt-in env var, so file changes only appeared after pressing `r`; task-launched `kobe ops` now enables `KOBE_FILETREE_WATCH=1` for that process while leaving other FileTree uses manual-refresh by default (KOB-255).
- **Switching a task's engine from the Tasks pane now takes effect** — pressing `v` to cycle a task's vendor (or renaming its branch) on a task whose tmux session is still running used to do nothing: entering it just switched back into the still-running OLD engine. The Tasks-pane enter path now runs the same `ensureSession` heal the outer monitor always did, so a vendor/branch/worktree change rebuilds the session on the next Enter from either surface (KOB-244).
- **Exiting the shell pane no longer destroys your engine session** — typing `exit` (or Ctrl+D) in a task's bottom shell pane dropped the session's pane count below the rebuild threshold, so the next Enter killed and rebuilt the whole session, throwing away the live `claude` / `codex` conversation. Session health is now keyed off the load-bearing engine pane (its `@kobe_role` tag), not a raw pane count, so closing a disposable shell/ops pane is harmless; this also makes the check per-window so a multi-tab (Ctrl+T) session is judged correctly (KOB-244).
- **A failed `tmux attach` is now surfaced instead of a silent bounce** — if a session fails to build, or dies between build and attach, the launcher shows the error in the workspace pane rather than flashing you back to the "press ⏎" splash with no explanation (KOB-244).
- **Deleting a task with uncommitted work asks before destroying it** — delete no longer force-removes the worktree unconditionally; it refuses a dirty worktree and re-prompts with an explicit "force delete anyway?" confirmation, and a failed worktree removal keeps the task entry instead of silently orphaning the directory on disk (KOB-244).
- **Stale TUI/daemon version pairs surface a clear upgrade message** — the daemon now validates the client's protocol version at `hello` (and the client checks the daemon's), rejecting a mismatch with "upgrade your kobe" instead of failing later with cryptic per-request errors (KOB-244).
- **Live preview no longer flashes "press ⏎ to enter" over a running session** — a momentarily-blank `capture-pane` (a TUI mid-repaint) is now distinguished from a genuinely absent session, so the empty-state hint only shows when there really is no session (KOB-244).
- **Rapid double-Enter on a task no longer races two session builds** — `ensureSession` is serialized per session name and both enter paths share one in-flight guard (KOB-244).
- **Auto-naming a task works from the workspace pane too** — entering a placeholder-titled task by pressing Enter while the workspace pane is focused now derives its title from the first prompt, the same as entering it from the sidebar (KOB-244).
- **Enter no longer leaks past a dialog into the task list behind it** — submitting a new-task / rename / settings-command dialog with Enter used to fall through the keymap to the Sidebar (which would enter a task) and swallow the dialog submit, because input-based dialogs submit via the native input, not a keymap binding. The Sidebar / launcher bindings are now gated on an empty dialog stack (KOB-244).
- **The Tasks pane's new-task / rename dialogs no longer zoom over the other panes** — they used to `resize-pane -Z` the Tasks pane full-window (hiding claude / ops / shell) for the dialog's lifetime; the dialog now shows in place (it already caps to the pane width) so the rest of the session stays visible (KOB-244).
- **Every Tasks pane + the outer monitor share one focus** — switching / entering a task anywhere highlights the SAME active task across all surfaces (via the new `active-task` channel), instead of each Tasks pane remembering its own last click. Also fixed the daemon client being disposed the moment a Tasks pane mounted (cleanup moved to the renderer's `onDestroy`), which had broken cross-pane sync and threw "daemon client disposed" on repeated switching (KOB-247).
- **The inner Tasks pane is a fixed-width rail** — it used a %-of-window split whose absolute width drifted with terminal size, between chat-tab windows, and across engine (claude/codex) rebuilds; now a fixed-cell rail so it's the same in every window. Narrowed to a thin 12-cell task-list column (the content floor set by the bottom legend's key chip), much tighter than the outer monitor's Sidebar (KOB-248, KOB-253).
- The Ops pane's Enter opens a full-width syntax-highlighted file/diff preview window (`kobe ops --preview`); the 0.6.0 notes mis-described this as the `@file` injection path. Plus tmux-client hardening: literal `send-keys -l` injection, concurrent stderr drain (no large-stderr deadlock), strict claude-pane resolution, charset-escape stripping in the preview, and a `RemoteOrchestrator.setBranch` / `setVendor` parity fix so the outer monitor can change branch/vendor through the orchestrator (KOB-244).

### Added

- **`@file` mention injection from the Ops pane** — pressing `a` on a file in the Ops pane types `@<path>` into the engine (claude/codex) pane via tmux send-keys (literal, no auto-submit — you decide when to send), with focus staying in the Ops pane so you can queue several. Enter still opens the full-width preview window. This wires the injection the 0.6.0 notes had promised (KOB-232).
- **Switching a task's engine relaunches it in place on a multi-tab session** — cycling vendor (`v`) on a task with several Ctrl+T chat-tab windows now `respawn-pane`s the engine pane in each window (preserving the windows, their other panes, and pane ids) instead of killing the whole session, so sibling chat tabs survive the switch (KOB-232).
- **Shortcut legend in the Tasks pane** — a small key hint footer pinned to the bottom of the inner Tasks pane (↵ open · n new · r/b/v name·branch·engine · ^h^j^k^l move panes · ^t new tab · ^q monitor) so the bindings are discoverable in place (KOB-244).
- **Per-engine launch command is configurable** — Settings → Engines lets you override the command each vendor's task pane runs, so a Claude binary that isn't on PATH as `claude` (e.g. it's `cl`) or one that wants default flags (`claude --model …`) just works; quotes are honored for flag values with spaces. Stored in `state.json`; empty = the built-in default; takes effect on the next task enter (KOB-245).
- **Daemon broadcast is a typed channel event-bus** — the daemon's push surface generalized from a single hardcoded task-snapshot to named channels (`task.snapshot`, `active-task`, …): adding one is a registry entry + `bus.publish` + `client.onChannel`. A last-value-per-channel cache replays the current value to a late-subscribing pane on connect. Same socket transport, no protocol bump (KOB-246).
- **GitHub Copilot CLI is selectable as a third engine** — `copilot` joins `claude` / `codex` as a task vendor (cycle it with `v` / `ctrl+e`): its interactive CLI runs in the tmux pane, and the monitor reads `~/.copilot/session-state` transcripts for auto-titling, the same way it reads Claude's and Codex's. Ported from the 0.5.x Copilot adapter down to v0.6's lean engine shape (binary discovery + history reader + usage snapshot — no spawn/stream path, since the engine runs in tmux now). The 0.5.x heavy adapter (spawn/stream/sessions/capabilities/app-server) was dropped (KOB-249).
- **Settings → Accounts is back** — a read-only view of locally-detected engine accounts: whether `claude` / `codex` / `copilot` are on PATH and which login (Anthropic OAuth, ChatGPT / API-key, Copilot token / OAuth) is configured. Detection is pure fs/env reads (no `claude /status` shell-out) and runs lazily the first time you open the section. Gemini is not listed — v0.6 dropped it as an engine (KOB-249).
- **The Ops pane flags new engine activity** — a `● new` badge lights in the top-right of the Ops (file-changes) pane when the task's engine produces new conversation output, so you can tell a background task did something without watching its claude/codex/copilot pane. The signal is the engine's own transcript JSONL (the same files the cost dashboard reads) — `~/.claude/projects`, `~/.codex/sessions`, `~/.copilot/session-state` — polled for a newer mtime, NOT a scrape of the tmux pane. Press `r` (refresh) to acknowledge and clear it. Works per task across all three engines (KOB-254).

## [0.6.0] - 2026-05-22

This is a **product reshape**, not a patch release. kobe is no longer a chat-stream renderer wrapped around `claude -p`; it is a task-launcher + outer monitor that delegates the whole interactive surface to tmux. The version bumps to `0.6.0` so the change is visible in `package.json`. The 0.5 line stays as-is for anyone who wants the self-rendered chat experience back.

### Why

Anthropic's 2026-06-15 billing change put `claude -p`, the Agent SDK, and every third-party programmatic caller on a separate \$200/month bucket; only **interactive** Claude Code stays on the regular subscription. kobe's v0.5 engine was the programmatic path, so heavy concurrent use ran straight into the \$200 cap. v0.6 drives interactive `claude` directly inside a tmux pane, so every token kobe spends is back on the subscription bucket.

### How

Each task gets a dedicated tmux session (`tmux -L kobe`, server-isolated from the user's own tmux). The session is pre-split into three panes the first time the user enters it: pane 0 (left, 60%) runs interactive `claude` natively, pane 1 (upper right) runs `kobe ops` (the v0.5 FileTree pane re-hosted as a subcommand — browse the worktree; `@file` injection into the claude pane is tracked for 0.6.x, KOB-232; falls back to an inline `git status` + tree watcher if the launch fails), and pane 2 (lower right) is a default-shell prompt scoped to the worktree. Outside the tmux session, the kobe TUI is now an outer monitor: a `WORKSPACE` view shows a live `tmux capture-pane` preview of the selected task's claude pane (1s refresh) on top, with a "press ⏎ to enter" launcher footer; a `COST DASHBOARD` view (toggle with `d` from the sidebar or `ctrl+d` globally) lists every task's input / output / cache-read / cache-create tokens summed from `~/.claude/projects/*.jsonl`, plus a TOTAL row. Pressing `⏎` in the workspace suspends the kobe renderer and hands the real TTY to `tmux attach`; `Ctrl+Q` (or `Ctrl+B D`) detaches and the session keeps running across detach AND a full kobe restart.

### Removed (no longer in any form)

The self-rendered chat surface and its supporting plumbing are gone. Not coming back. The following are deliberately removed and will **not** be re-added — `claude` / `codex` already provide them natively inside the tmux pane: the whole chat pane (composer, message list, tool-row renderers, TodoWrite checklist, AskUserQuestion / ExitPlanMode approval pickers, `@file` mentions, queued prompt editing, bash composer mode, `/recap`, context meter, model picker, resume-session picker, slash-command discovery, recap-on-tab-leave); the headless engine port and every vendor adapter's spawn / stream / registry path (only the binary-discovery + history-reader pieces of `claude-code-local` and `codex-local` survive — used by the cost dashboard, not by any live engine driver); the `gemini-local` adapter entirely (no interactive TUI equivalent worth wrapping); the Preview pane (file / diff viewer), the Terminal pane (Bun PTY), and the FileTree pane in the outer TUI (files + terminal live inside the tmux session now); the daemon's chat / PR / merge / plan-usage / rc-bridge RPCs (the wire protocol drops from 30+ methods to 13: task CRUD + `subscribe` + `task.ensureWorktree`); the whole behavior-test harness, the fake-engine HTTP side-channel, and every test that asserted on streamed event shapes; `kobe diagnose`, `kobe mcp-bridge`, `kobe api`, `kobe skill` (the MCP bridge in particular — kobe no longer hosts the engine, so there's nothing for spawned claude to call back into via MCP).

### Kept (intent only — reshaped landing in 0.6.x)

These were valuable v0.5 surfaces that don't survive in their old form but will be reimplemented in the new model (KOB-232 tracks): **quick-fork** — sidebar shortcut → pick base branch → new worktree + new tmux session; **create-PR** — Ops-pane shortcut → render `pr/instructions.ts` template → `tmux send-keys` into the claude pane; **file preview** — sub-mode inside the Ops pane (split top/bottom: file list + diff / cat).

### New subcommands

`kobe ops --task-id <id> --worktree <path> --target-pane <pane>` — the Ops pane that fills the right-hand side of a task's tmux session. It re-hosts the v0.5 FileTree (the `git ls-files`-driven tree with All / Changes tabs) in its own process; `@file` injection into the claude pane via `tmux send-keys` is tracked for 0.6.x (KOB-232). Not meant to be run by hand — the launcher wires it into the tmux split automatically.

### Schema

`TaskIndex` bumps to v3 — drops `tabs`, `activeTabId`, `sessionId`, `model`, `modelEffort`, `permissionMode`. Old v1 / v2 manifests are migrated on load by silently stripping the dropped fields; downgrading is not supported. Daemon protocol bumps to v2 — v1 clients are rejected with a clear "your kobe is v0.5, upgrade" error.

### Thanks

To Jackson for steering the pivot end-to-end — design doc, scope cuts, and the call to ship the reshape as a minor instead of stretching 0.5.

## [0.5.29] - 2026-05-25

### Added

- **GitHub Copilot CLI can be selected as a local engine** — adds a first-class `copilot` adapter alongside Claude Code, Codex, and Gemini, with Copilot model choices, JSONL stream parsing, resume/history support from `~/.copilot/session-state`, full-access/plan-mode permission mapping, and Settings → Accounts detection for `copilot` login state (KOB-221).
- **Copilot model picker now includes newer high-end choices** — adds GPT-5.5 and Claude Opus 4.7 to the Copilot catalog while removing GPT-5 mini and Claude Haiku 4.5 from the selectable allow-list (KOB-238).
- **Model picker choices are grouped by provider** — the picker now shows collapsible provider sections and opens with the active tab's provider expanded so growing engine catalogs stay scannable (KOB-239).

### Changed

- **Skill distribution moved to `npx skills`** — the `kobe` skill now ships from `.agents/skills/kobe/` (a directory [`vercel-labs/skills`](https://github.com/vercel-labs/skills) scans by default) instead of being copied into the npm tarball under `share/skills/`. `kobe skill install` is now a deprecation shim that points you at `npx skills add Sma1lboy/kobe --skill kobe --agent claude-code`; `kobe skill uninstall` and `kobe diagnose`'s skill probe keep working for cleanup. Repo-internal skills (`linear`, `changelog-generator`) are flagged `internal: true` so the `npx skills add` discovery filter never installs codesfox/kobe-team tooling onto external users (KOB-210, KOB-211).
- **Status bar shortcut hints are quieter** — the bottom footer now keeps Help visible while showing only the highest-value focused-pane actions, including Chat's new-tab and fork shortcuts; low-frequency, destructive, and picker-specific shortcuts stay discoverable in Help instead of crowding small terminals (KOB-241, KOB-242).

### Fixed

- **Copilot startup no longer fails on plan-gated Codex model ids** — removes `gpt-5.3-codex` from kobe's Copilot picker and lets the Copilot CLI own `COPILOT_MODEL` / `~/.copilot/settings.json` default resolution instead of echoing those values back as a hard `--model` flag (KOB-222).
- **Copilot result-only sessions now attach correctly** — handles Copilot CLI runs that omit `session.start` and only report `sessionId` on the final `result` event, and avoids duplicate final assistant messages after streamed deltas (KOB-223).
- **Copilot streams attach before the final result event** — fresh runs now start with a kobe-owned UUID via `copilot --session-id`, resume turns bind immediately to the known session id, and Windows npm `.cmd` / `.bat` shims launch through `cmd.exe` instead of failing after binary discovery (KOB-233).
- **Copilot launch failures now surface after early binding** — process-level startup errors such as missing binaries or rejected shims are queued as visible engine errors even when kobe already created the session handle for live streaming (KOB-235).
- **Copilot Auto no longer passes unsupported reasoning effort** — `auto` and Copilot models without explicit effort variants omit `--effort`, avoiding failures when Copilot chooses a model such as Claude Haiku that rejects reasoning effort configuration (KOB-236).

## [0.5.28] - 2026-05-22

Release tag only. The publish workflow failed before npm publish and GitHub Release creation; the user-facing change is included in `0.5.29`.

## [0.5.27] - 2026-05-18

### Added

- **Claude Code task checklists render inline** — `TodoWrite` and the v2 `TaskCreate / TaskUpdate / TaskList / TaskGet` tool calls no longer dump raw JSON into the chat; they render as a Claude-Code-style checklist with `✓` done / `◼` in-progress / `◻` open glyphs, completed rows dim+strikethrough, in-progress bold, and a per-round banner (`▶ TaskList · 3 todos · ✓1 ◼1 ◻1`) that expands on click. A `TodoStatusLine` panel flows inside the scrollbox next to the thinking spinner and hides itself 5s after a round goes all-done. v2's whole-store snapshots are rounded client-side so previously-completed tasks don't bleed back into later rows (KOB-204).
- **`/recap` slash command + auto-recap after leaving a tab** — type `/recap` (or pick it from the slash dropdown) to get a dim 1-3 sentence "while you were away" summary of the current chat tab: high-level task plus concrete next step, no status reports or commit recaps. Leaving a tab also arms a one-shot 5-minute timer that fires the same recap if you don't return in time — so the row is already waiting at the tail of the chat the next time you look. The timer skips at fire time if the tab is mid-turn or already has a recap since the last user message; returning to the tab before 5 minutes cancels it. Mirrors Claude Code's blur-timer pattern (`hooks/useAwaySummary.ts`). Generated via the active engine's small-fast model (haiku 4.5 for Claude, gpt-5.4-mini for Codex, Gemini 3 Flash for Gemini); the recap row is purely a chat affordance and is never written to the engine's session JSONL (KOB-205).
- **Quick-Fork dialog picks the base branch** — the `ctrl+f` Quick-Fork dialog now has a Branch region between Model and Prompt that defaults to the source task's current branch and lets you fuzzy-pick any local branch instead. Tab cycles Model → Branch → Prompt, ↑/↓ navigates the branch list, and the dialog header tracks the live selection (`Forking from <repo> (<baseRef>)`) so the chosen ref flows through to `orchestrator.createTask` (KOB-203).

### Changed

- **Sidebar search shows a match count** — typing in the sidebar search now displays `N/total` next to the cursor (e.g. `/auth █ 3/12`) so you can see how aggressively the query is filtering, and the empty-result text changed from "No matching tasks." to "No matching tasks — esc to clear." for a clearer escape affordance.
- **Sidebar spinner fires whenever any chat tab is live** — the row spinner now keys off `isLive()` for any of the task's tabs instead of `task.status === "in_progress"`, so a non-active tab that is mid-stream is no longer invisible from the sidebar.
- **Changes tab now shows a git status legend** — switching the FileTree to the Changes tab renders a compact legend (`M modified · A added · D deleted · ? untracked`) so glyph meanings are obvious without leaving the pane; the All tab stays uncluttered.
- **Status bar surfaces new chat-tab hints** — `ctrl+t` (new tab) and `ctrl+w` (close tab) now have `hint` entries that appear in the status bar's Chat column when the workspace pane is focused, and the `files.tab` description reads "cycle All / Changes" to match the simplified tab set.

### Removed

- **`ctrl+b` background-tasks manager is gone** — the double-press `ctrl+b` dialog, the status-bar background-count chip, and the one-line "running in background" readout above the composer are all gone, along with their supporting machinery. The feature mirrored Claude Code's background-task model, but kobe spawns `claude -p` per turn and exits the engine process at the end of each turn, so the cross-turn `run_in_background` semantics the surface implied don't actually hold — a queued prompt or `BashOutput` poll on the next turn cannot reach a shell handle that lived in the previous (now-exited) `claude -p` invocation. The surface was advertising a guarantee the architecture cannot keep, so it's been pulled. `ctrl+b` is unassigned again (KOB-206).
- **FileTree "Checks" tab removed** — it was a dead-end placeholder with no data source. `[` / `]` now cycles between All and Changes only.

## [0.5.26] - 2026-05-17

### Fixed

- **`/clear` no longer opens a model picker** — `/clear` is a conversation reset; after clearing, the session is dropped so the vendor lock lifts automatically and the user can freely switch engines via the manual model picker on the next turn. The automatic post-clear model picker popup is removed entirely.
- **deleteTask no longer leaks engine handles when pauseTask fails** — the fallback cleanup path in the delete-task error branch now calls the same `stopAllTabsForTask` helper used everywhere else, which iterates composite `taskId:tabId` handle keys; the previous code passed a bare `taskId` that matched no key and left stale handles in the map.
- **Vendor validation error now includes the invalid value** — passing an unrecognized vendor string to daemon API calls now reports `"vendor 'xyz' is not a supported vendor (expected: claude, codex, gemini)"` instead of the opaque `"vendor must be a supported vendor"`.
- **PR status lifecycle resets to "creating" when no GitHub PR is found** — previously, when `gh pr view` returned no data (PR deleted or closed without merging), the lifecycle field was preserved from the previous poll, leaving the merge button incorrectly enabled. It now resets to `"creating"` so the button returns to its default "open PR" state.
- **Gemini `listCommands()` now matches the `AIEngine` interface signature** — the Gemini adapter was missing the `opts?: EngineCommandDiscoveryOpts` parameter, which meant cwd-scoped command discovery hints were silently ignored.

## [0.5.25] - 2026-05-17

### Added

- Background-tasks manager — double-press `ctrl+b` to open a dialog listing every chat session running out of view across all tasks, with the run/needs-input state for each; press enter to jump straight to a session or `x` to interrupt it. A status-bar indicator shows the background count, and a one-line readout above the chat composer names the background runs as you type. Self-hides when nothing is running unattended. Mirrors Claude Code's background-task model and `ctrl+b` double-press.
- **Pausable chat queue** — a low-priority `[pause queue]` / `[resume queue]` toggle in the composer queue panel holds auto-drain, so queued prompts wait until you resume instead of firing as each turn ends (KOB-189/190).

### Changed

- **Sidebar task rows are legible at a glance** — a distinct glyph per status (`✓` done, `◐` in review, `○` backlog, `⊘` canceled, `✕` error), a rotating braille spinner while a task's engine is live (falling back to a static `●` when in progress but idle), and `+N` / `−N` diff counts split into green / red spans. All badges drawn bold (#58).
- **Queue edit control is a single-letter `[e]` chip** — the queued-prompt row's edit control was the spelled-out word `[edit]` while the send-now and cancel controls beside it were single-glyph chips; all three now share the same bracket-chip shape (KOB-182).

### Fixed

- **The daemon no longer dies silently on a stray async error** — it now runs with a crash net (`unhandledRejection` / `uncaughtException` handlers) that logs the failure and keeps serving, instead of any unhandled rejection from a fire-and-forget call instantly terminating the process with no trace. The detached daemon's stdout/stderr are redirected to `<KOBE_HOME>/.kobe/daemon.log` (was `/dev/null`), and fire-and-forget failures are tagged with their subsystem so the log points straight at the failing area (KOB-193).
- **Tasks stop auto-marking themselves done** — a clean turn end flipped `task.status` to `done`, so the active sidebar filled up with tasks marked done. Turn end now rests at `in_progress`; `done` is reserved for an explicit archive. Legacy rows mismarked `done` self-heal to `in_progress` on load (#58).
- **Esc / interrupt now reaps the whole engine process tree** — engine subprocesses (`claude` and `codex`) spawn detached so the stop path signals the whole process group, killing the subagent and tool/sandbox children that a PID-only kill used to leave running. The registry slot is also freed synchronously, so a prompt sent right after an interrupt no longer collides with `SessionRegistry: duplicate sessionId` (KOB-178).
- **`/clear` model picker stays on the current engine** — `/clear` resets the chat tab; it is not an engine switch. The post-clear model picker now pins to the active tab's vendor instead of letting you pick a different engine's model (KOB-178).
- **Changelog dialog no longer garbles release notes** — GitHub release bodies arrive with CRLF line endings; the markdown parser now normalizes them so stray carriage returns stop rendering as garbage glyphs, and the trailing "Full release" link gains bottom padding so it no longer sits flush against the dialog border (KOB-179).
- **Message list stops twitching during streaming** — the transcript reconciles its render items by reference, so an `assistant.delta` or tool event re-renders only the rows that changed instead of rebuilding every visible row (KOB-185).
- **Queued chat prompt no longer escapes mid-question** — a resume-turn lock closes the window where the queue drained between an input picker resolving and the resume turn starting. PR / local-merge injection is guarded against a busy tab, and send-now no longer drops a queued prompt while a question or approval is still pending (KOB-186).

## [0.5.23] - 2026-05-17

### Changed

- Make chat slash commands engine-owned: Claude tabs keep Claude Code commands/skills, while Codex tabs surface Codex skills with Codex-compatible `$skill` invocation.
- Keep chat slash command names visible before truncating descriptions so long Codex skill summaries do not crowd the composer.
- Refresh chat slash commands when an unstarted tab switches engines so Codex and Claude command lists do not stick across model changes.
- Hide the chat topbar session id label so internal engine ids no longer show in normal use.
- **Rename chat tab moves from `Ctrl+R` to `F2`** — `Ctrl+R` is the shell-readline / Claude Code reverse-i-search convention, claimed in this release by the new cross-task prompt-history palette (KOB-154). Rename tab gets `F2` instead — the cross-OS / cross-IDE rename chord. Same workspace scope, same behavior, just a different key (KOB-156).
- **Breaking: `kobed` is gone — daemon lifecycle moved to `kobe daemon ...`** — the standalone `kobed` binary was merged into the single `kobe` binary as part of the CLI surface unification (KOB-134/KOB-136). Use `kobe daemon start|stop|status|restart` from now on. The npm package no longer publishes a `kobed` bin and the release tarballs no longer include a separate `kobed` executable. Update any scripts or aliases that invoke `kobed` directly.
- **Gemini model choices are explicit instead of auto-routed aliases** — the Gemini picker now offers `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, and `gemini-2.5-pro`, with `gemini-3.1-pro-preview` as the fallback default, so coding sessions do not silently drift through Gemini CLI's `auto` routing (KOB-155).

### Added

- **Composer prompt history persists across sessions** — submitted prompts now land in `~/.kobe/composer-history.jsonl` (respecting `KOBE_HOME_DIR`) and replay into the Ctrl+R palette when you restart kobe, so "I sent that one yesterday" is recoverable. JSONL shape mirrors Claude Code's `~/.claude/history.jsonl` (one `{display, timestamp, project}` per line). Disk writes are fire-and-forget and the file caps at 1000 newest entries (atomic prune via tmp + rename). The per-tab up-arrow ring stays session-local so new chat tabs don't get cluttered with unrelated old prompts; cross-session recall flows through `Ctrl+R` (KOB-157).
- **`Ctrl+R` opens a cross-task prompt-history palette** — the up-arrow in the composer still walks the current task's history, but `Ctrl+R` opens a centered palette that aggregates prompts from every task you've sent during the session. Type to fuzzy-filter by task title or prompt text, ↑/↓ to navigate, Enter to recall — bash-mode entries (`!cmd`) show a `[bash]` tag in the list and the recalled command snaps the composer back into bash mode for you, same as KOB-151's up-arrow path (KOB-154).
- **`kobe api <verb>` shell surface for driving kobe from any agent with Bash** — five short-lived verbs (`spawn-task`, `create-tab`, `send`, `get-task`, `get-tab`) talk to the running daemon and print JSON on stdout. Designed to replace the MCP bridge for the fan-out use case while staying agent-portable (Claude Code, Codex, Cursor, custom). Daemon-missing is a hard error (`BAD_DAEMON`, exit 2). MCP bridge stays in tree as a fallback (KOB-134/KOB-138).
- **Gemini CLI can be selected as a local engine** — adds a first-class `gemini` adapter alongside Claude Code and Codex, with Gemini model choices, `stream-json` event parsing, resume/history/delete support against Gemini's local session files, and plan/full-access permission mapping (KOB-155).
- **`kobe skill install` ships a bundled SKILL.md that teaches the model when to fan out** — writes `~/.claude/skills/kobe/SKILL.md` from the npm-packaged copy, with `--yes` to overwrite. `kobe diagnose` now reports the install state so you can see at a glance whether the skill is active. Companion to `kobe api` — the capability alone does not change behaviour without a skill telling the model when to use it (KOB-137).
- **Sidebar archive/delete actions now require an explicit confirmation choice** — pressing `a` opens an Archive/Unarchive confirm before moving a task between Working session and Archives, and destructive delete/remove-saved-repo confirms now default to Cancel so a stray Enter cannot commit the action (KOB-133).
- **Tasks can start an AI-assisted local merge with `M`** — press Shift+M on a sidebar task to confirm a local merge, create a dedicated Merge chat tab, and inject a prompt that asks the agent to merge the task worktree into the parent repo checkout without creating a PR (KOB-110).
- **New tasks inherit the active chat model** — creating a task now seeds its first chat tab from the current or last-active chat tab's engine/model/reasoning settings, falling back to defaults only when no prior model config exists (KOB-129).
- **Resume history shows sessions from every engine** — the resume picker now loads Claude Code and Codex sessions for the task worktree, labels each row with its owning engine, and opens the selected session on the matching engine tab (KOB-130).
- **Create PR now tracks GitHub PR readiness** — after the topbar PR prompt starts, kobe polls the branch's GitHub PR status, shows CI/check states in the top-right chip, falls back to no CI display for non-GitHub providers, and turns the chip into a merge-prompt action once the PR is ready (KOB-132).

### Fixed

- Show Gemini CLI login state in Settings → Accounts, including Google OAuth, Gemini API key, and Vertex AI environment auth modes.
- **Up-arrow history recall restores bash mode for `!`-prefixed entries** — recalling a previous `!cmd` submission now flips the composer back into bash mode and strips the `!` prefix, mirroring how the entry was originally submitted. Previously the `!` came back as literal text and the user had to re-trigger bash mode by hand (KOB-151).
- **Slash command Tab completion works across terminal Tab event shapes** — the chat composer now treats both named `tab` events and raw `\t` sequences as autocomplete Tab, so highlighted slash commands and file mentions complete instead of falling through to textarea/default focus behavior (KOB-139).
- **Started chat tabs stay bound to their engine** — once a chat tab has a Claude Code or Codex session, the model picker keeps other-engine models visible but disabled with a new-chat-required hint, and the orchestrator rejects cross-engine retargeting so history/resume data cannot cross vendors (KOB-128).
- **Task metadata naming now follows the selected chat-tab engine** — branch/title suggestions route through the active tab's `AIEngine` with its selected model and reasoning effort instead of always shelling out to Claude (KOB-111).
- **Task title suggestions wait for enough chat context** — new tasks keep the first user prompt as the cheap fallback title, then after three completed user turns ask the selected engine for a feature-style task name without overwriting manual renames (KOB-113).

## [0.5.22] - 2026-05-13

### Added

- **Daemon launch mode has first-class CLI flags** — run `kobe --daemon` to launch the TUI against the shared long-lived daemon, or `kobe --single` to spell the default per-TUI owned daemon explicitly, while `KOBE_DAEMON_MODE=shared` stays supported for scripts (KOB-103).
- **Composer file paths can open preview tabs** — when the chat input contains an existing worktree-relative file path, the composer renders a clickable `open` chip that swaps the workspace into the existing file preview tab (KOB-104).
- **Queued prompts can be edited inline before they run** — click a queued prompt row or its `[edit]` action to load it back into the composer, adjust the text, and keep its position in the pending queue (KOB-96).

### Fixed

- **New chat tabs preserve active chat model settings** — `ctrl+t` now copies the active chat tab's model configuration before assigning the new tab id/session, so settings like GPT/Codex reasoning effort carry over instead of falling back to defaults (KOB-108).
- **Codex reasoning rows render as “思考过程” instead of raw JSON** — app-server and exec-stream reasoning items now show a clean thinking-process row without exposing `reasoning({"summary":[],"content":[]})` payloads (KOB-102).
- **Codex tool calls rehydrate after restart** — persisted `function_call` / `function_call_output` rows now reload as paired tool rows instead of disappearing from the chat transcript (KOB-105).
- **Codex history hydration now covers non-message transcript items** — custom tool calls, visible reasoning summaries, and single-record web/search/local-shell tool items reload after restart instead of being silently dropped (KOB-106).

## [0.5.21] - 2026-05-13

### Added

- **Chat composer now has a shell-command mode** — type `!` at the start of the composer to switch into bash command mode, run local shell commands from chat, and keep command output in the conversation flow (KOB-83).
- **Terminal pane can reset the running shell with F5** — press F5 in the terminal pane to restart the embedded shell without restarting the whole TUI.

### Fixed

- **MCP bridge processes now exit when their parent disappears** — orphaned bridge subprocesses self-terminate instead of lingering after the owning kobe process exits (KOB-98).

## [0.5.20] - 2026-05-13

### Fixed

- **Disconnect recovery now restarts the right daemon in single-point mode** — the daemon-disconnected Restart action now brings back the per-TUI owned daemon socket instead of accidentally starting the shared background socket, and reconnect clears stale socket handles before rehydrating the task list (KOB-95).
- **Filtered dev launches keep the TUI on the direct Bun path** — `bun --filter @sma1lboy/kobe dev` now starts the opentui entrypoint through `env ... bun ...`, avoiding the failed pseudo-terminal/wrapper launch paths that left the screen half-initialized with raw mouse escape sequences visible (KOB-95).
- **Owned daemons now stay alive after TUI mount** — the single-point daemon is stopped from the renderer destroy / quit path instead of a `finally` after `render()`, because `@opentui/solid` returns after mounting; this fixes immediate `daemon client disposed` history-load failures on launch (KOB-95).
- **Codex app-server transcript items no longer render as tool rows** — `userMessage` / `agentMessage` app-server items are now filtered as transcript bookkeeping instead of being shown as green `userMessage(...)` tool output in chat (KOB-95).
- **Codex now defaults to the app-server backend** — Settings → Codex lets users switch back to the `exec --json` fallback, while `KOBE_CODEX_BACKEND=exec|app-server` and `KOBE_CODEX_APP_SERVER=1` remain explicit environment overrides; backend changes apply after Restart backend or the next launch (KOB-95).
- **TUI launches in single-point daemon mode by default** — a normal TUI session now starts its own owned daemon on a per-process socket and stops that daemon when kobe quits, so branch/env changes are picked up immediately; set `KOBE_DAEMON_MODE=shared` to opt back into the long-lived shared daemon socket (KOB-94).
- **Codex can run through an app-server backend** — kobe can drive Codex through stdio JSON-RPC so it consumes official `thread/tokenUsage/updated` context totals, with the older `exec --json` path retained as a fallback (KOB-93).
- **Codex/GPT context telemetry no longer double-counts or fakes precision** — Codex `exec --json` emits cumulative usage where cached input is already part of input tokens and omits the official `last.totalTokens` / `modelContextWindow` pair, so kobe normalizes the usage shape for the WORKSPACE meter, suppresses derived `t/s`, hides that meter when no real context window is available (instead of inventing a denominator), and when an engine supplies a window plus kobe-estimated context totals marks them with `~` (KOB-84).

## [0.5.19] - 2026-05-12

### Fixed

- **Model picker now chooses model before effort** — the picker first lists each model once, then asks for an effort/reasoning level when the selected model supports one, and the composer footer continues to show the active `model · effort` combination (KOB-81).

## [0.5.18] - 2026-05-12

### Fixed

- **Self-update no longer prints npm peer-dependency warnings for Solid** — kobe now declares the `solid-js@1.9.12` version required by `@opentui/solid@0.2.4`, so `kobe update` / the topbar updater can install the latest npm package without the noisy `ERESOLVE overriding peer dependency` warning (KOB-80).

## [0.5.17] - 2026-05-12

### Changed

- **Worktree directories now use short animal-name slugs** — KOB-65 replaces the 26-character ULID directory names (`<repo>/.claude/worktrees/01KRD9TZAZRDXHRYA23AT2A77R/`) with a Conductor-style pool of ~410 animal names allocated per repo (`<repo>/.claude/worktrees/panda/`), with `-v2`/`-v3` suffixes when a slug is recycled after archive. Branch names and PR titles remain the source of truth for "what this work is"; the slug is just "where it lives on disk", and now fits comfortably in a terminal prompt. Existing ULID-named worktrees keep their dirs and are not migrated; only new tasks get animal slugs.

### Fixed

- **Codex model picker no longer offers the broken `minimal` reasoning option** — real `codex exec` rejects `model_reasoning_effort="minimal"` with the default tool set, so the picker now exposes only the effort levels that smoke-tested successfully (`none`, `low`, `medium`, `high`, `xhigh`).
- **Topbar session ids now come from the active engine session** — the branch header no longer falls back to the deprecated task-level `sessionId`, and Codex sessions bind to the persisted rollout id from `session_meta` so the displayed `sid` is the id that history and resume actually use.
- **Plan-mode switching is visible again for Claude Code and Codex** — the composer footer now always shows the active engine-owned mode label (`default` / `full access` / `plan mode`) as a clickable control, with shift+tab still cycling the same mode.
- **Fast Codex follow-up prompts no longer trip duplicate session registration** — Codex turns release their stop-registry slot as soon as a terminal stream event arrives, and delayed cleanup from the previous subprocess can no longer unregister the newer subprocess that reused the same rollout id (KOB-79).

## [0.5.16] - 2026-05-12

### Fixed

- **Multi-model chat tabs now surface live engine failures correctly** — the stream pump resolves the engine from the concrete chat tab instead of the legacy task-level vendor, so Claude rate-limit errors and other terminal failures leave the waiting state immediately without requiring a TUI restart.
- **Engine API errors now become failed turns instead of successful completions** — Claude Code `result` records with `is_error` / `api_error_status` are normalized to terminal engine errors even when the raw `subtype` is `success`.
- **Model changes target the selected chat tab** — the model picker sends the tab id through the remote daemon path so switching a tab to Codex or Claude updates that tab's composer placeholder and routing without depending on daemon-side active-tab timing.
- **Chat errors render as a separate status banner above the composer** — current-turn errors now use a light element-surface banner outside the transcript and input field, while the transcript still keeps the system error row for history.

## [0.5.15] - 2026-05-12

### Added

- **Terminal pane now uses a real Bun PTY rendered through headless xterm** — task shells run under `Bun.spawn({ terminal })` so `tty`, prompts, cursor movement, resize, and ordinary interactive shell behavior work without tmux; `@xterm/headless` maintains the screen buffer and kobe reads per-cell colors/attrs back into the opentui render path.
- **Topbar can self-update kobe** — when the npm version check finds a newer release, the left topbar shows `[Update]`; confirming leaves alt-screen, runs the existing GitHub-hosted update script, then exits so relaunch starts the new binary.

### Changed

- **Workspace pane now opens wider by default** — fresh layouts seed the center WORKSPACE pane at 70% of the space remaining after the task sidebar, leaving the right FILES/TERMINAL rail at 30% while preserving any width the user already dragged and persisted.
- **Terminal pane no longer depends on tmux** — embedded task shells now run through Bun's native PTY path, removing tmux session/control-mode state from the terminal path while preserving real terminal behavior.
- **Pipe terminal fallback no longer suspends the host TUI** — the opt-in pipe backend runs shells non-interactively over stdin/stdout pipes instead of passing `-i`, avoiding shell job-control reads from the controlling terminal that could suspend `bun run dev`.

### Fixed

- **Terminal input is less laggy and the viewport follows live output** — the PTY renderer now converts only the visible window plus a small scrollback margin, coalesces refreshes to roughly one frame, keeps the pane pinned to the bottom while live, and renders the cursor inline with the xterm text so typed spaces and cursor position share one coordinate system.

## [0.5.14] - 2026-05-12

### Changed

- **Workspace pane now opens wider by default** — fresh layouts seed the center WORKSPACE pane at 70% of the space remaining after the task sidebar, leaving the right FILES/TERMINAL rail at 30% while preserving any width the user already dragged and persisted.

## [0.5.13] - 2026-05-12

### Fixed

- **Large worktrees no longer freeze the TUI during pane IO** — file-tree git scans and preview git/file reads now run asynchronously instead of blocking the JS event loop, preview reads cap huge files at 2 MiB, recursive file-tree watching is opt-in via `KOBE_FILETREE_WATCH=1`, and stale slow scans can no longer overwrite newer pane state.

## [0.5.12] - 2026-05-12

### Fixed

- **Update notifications check npm on every launch** — the topbar no longer waits on the old 6-hour version cache, so newly published versions show the `↑ vX.Y.Z available!` chip as soon as the registry reports them.

## [0.5.11] - 2026-05-12

### Added

- **Active task worktrees can open directly in an editor** — the top bar now shows a dynamic `[Open] VS Code/Cursor/...` chip and `ctrl+o` opens the active task worktree via the first detected editor (`KOBE_OPEN_EDITOR`, VS Code, Cursor, Windsurf, Zed, or the platform opener).

## [0.5.10] - 2026-05-12

### Fixed

- **Update prompt now points at a GitHub-hosted script** — the update dialog no longer suggests `bun install -g`; it shows `curl -fsSL https://raw.githubusercontent.com/Sma1lboy/kobe/main/scripts/update.sh | sh`, and `kobe update` delegates to the same remote script so future install-flow changes only require editing `scripts/update.sh`.

## [0.5.9] - 2026-05-11

### Fixed

- **Interrupted prompts now reach the model on the next turn** — `claude -p` only persists the user turn to its session JSONL on natural completion, so a mid-stream SIGTERM (steer / ESC) used to drop the prompt on the floor and the next `--resume` read an incomplete history. The engine now appends a synthetic user record on `stop()` (with merge-into-prior-user when a chain of steers stacks, plus an idempotent skip when claude flushed just before our kill). Because the rescue is on disk, a kobe restart preserves the prompt too.
- **Rapid-fire prompts no longer fragment a chat across N orphan sessions** — a fast typist firing Enter twice before the first turn's `user.inject` had round-tripped through the daemon's event bus used to enter the spawn branch N times, each opening a fresh JSONL, all but the last orphan on disk and the model cold-starting its prompt cache every turn. A first-spawn coalescing latch on the orchestrator now serialises the initial spawn per tab; later runTasks await it and resume the just-established session. Regression test asserts 3 concurrent `runTask` calls = 1 spawn + 2 resumes.
- **Steer (ctrl+enter and `[▶]`) is now atomic** — replaces the chat-side `interruptTask + runTask` compound with a single `chat.steer` RPC. The dispatch lock on the TUI wraps one await instead of two, closing the race where the queue-drain effect dispatched a duplicate `runTask` between the interrupt and the new prompt landing.

### Added

- **Queued prompts render inside the composer rail with a `[▶]` retrigger button** — the queue list used to sit between the spinner and the composer as a separate block; it now lives above the textarea inside the same bordered block as the input it'll flush. Each row has `[▶]` next to `[x]`; clicking `[▶]` interrupts the in-flight turn and immediately dispatches that queued prompt instead of waiting for the head to drain (engine-side JSONL rescue applies, so the abandoned head's prompt still reaches the model).
- **New-task dialog gains an explicit Create button** — Tab now cycles `repo → baseRef → confirm → repo`; Enter on the repo or baseRef inputs is pure selection (advances focus, never submits), and commit lives exclusively on the bottom-right `[ Create ]` chip (Enter when focused, or mouse click). Closes the "Enter to dismiss picker = accidentally create task" footgun.
- **New-task baseRef defaults to the repo's actual current branch** — reads `git rev-parse --abbrev-ref HEAD` (2-second timeout, fault-tolerant) so a worktree forked from a feature branch defaults to that feature branch instead of silently jumping to `main`. The field auto-syncs when you change the repo path; a manual edit pins the override.
- **New-task dialog defaults to the currently-selected task's repo** — `openNewTaskFlow` now prefers the selected task's `repo` over the persisted `lastNewTaskRepo` (falling back to `cwd` as a last resort). Same-repo follow-ups are the common case, so the dialog opens pre-pointed at the path you're already looking at.

## [0.5.8] - 2026-05-11

### Fixed

- **ESC stops yanking focus out of the chat composer** — ESC was globally bound to "back to sidebar" (`focus.detach`), so any idle ESC press while editing silently kicked the keyboard back to the task list. Removed the global binding entirely; ESC now belongs to DialogProvider (close top dialog) and Chat.tsx (interrupt streaming turn) only, and idle ESC is a no-op so the composer keeps focus mid-edit. Use `ctrl+q` for an explicit "back to sidebar" detach.

## [0.5.7] - 2026-05-11

### Fixed

- **Queued prompts survive task switches** — switching to another task and back used to wipe the per-tab `ChatState` map in one shot, so anything queued with shift+enter was gone the moment focus left the task. Hoists `statesByTab` to module scope in `useChatSession` (mirroring the same fix #16 just landed for `draftsByTab`), so both per-tab maps now outlive every Chat unmount — task switches, file-preview swaps, anything that flips the workspace `<Show>`. `isStreaming` is also re-synced from the orchestrator's authoritative run-state on every re-attach so a turn that completed off-screen drops its spinner instead of locking the composer (KOB-61).

## [0.5.6] - 2026-05-11

### Fixed

- **`npm install -g @sma1lboy/kobe` actually launches** — first-run `kobe` could fail with `daemon did not start at ~/.kobe/daemon.sock` because the CLI looked for the kobed entry at `dist/cli/bin/kobed.js` (double-counted the `/cli` segment) instead of `dist/bin/kobed.js`, fell back to a `process.cwd()`-relative path that also didn't exist, then spawned a nonexistent script with `stdio: "ignore"` so the ENOENT was silently swallowed and only the 5-second connect-loop timeout surfaced. Resolves the entry via `import.meta.url` instead of `process.argv[1]` and throws on a missing entry so any future regression is loud (KOB-60).

## [0.5.5] - 2026-05-11

### Added

- **Standalone executables on the GitHub Release page** — every release now ships pre-built `kobe` + `kobed` binaries for darwin-arm64, darwin-x64, linux-x64, and linux-arm64 as `kobe-<platform>-<arch>.tar.gz`. Extract the tarball and drop both binaries onto your `PATH`; no Bun runtime install required. The npm package (`@sma1lboy/kobe`) keeps shipping the JS bundle for users who prefer `npm install -g` plus their own Bun.
- **Per-ChatTab completion notifications** — chat tabs that finish a turn while in the background now ring the terminal bell, optionally play a `pulse.wav` chime via the first audio player on `PATH` (afplay / ffplay / mpv / aplay / …), and surface a transient toast in the workspace header. Settings dialog exposes a Sound toggle and a Toast toggle independently (KOB-56, KOB-57).
- **Composer locks for archived tasks** — opening an archived task now disables the chat composer with a placeholder explaining why, so a stray keystroke can't try to send into a frozen session (KOB-58).

### Fixed

- **GitHub Release page actually has assets** — the workflow's upload glob pointed at `packages/kobe/dist/index.js`, but the build emits `dist/cli/index.js` and `dist/bin/kobed.js`; the upload step silently matched zero files, so every prior release shipped with only the auto-generated source archives. Replaced by the matrix-driven binary attach above.
- **Legacy duplicate "main task" rows consolidated** — opening a saved repo that had picked up a stale duplicate main-task entry now collapses through `store.remove`, so the task list shows a single canonical row instead of two stacked tabs.
- **File preview wraps long lines** — preview pane now soft-wraps wide lines instead of horizontally clipping past the viewport (#10).

## [0.5.4] - 2026-05-10

### Added

- **`/clear` slash command resets the active chat tab** — typing `/clear` (or picking it from the slash dropdown) wipes the visible messages, drops the tab's Claude session id so the next prompt spawns a fresh session instead of resuming, and stops any in-flight engine handle for the tab; the on-disk JSONL transcript is intentionally preserved so the prior conversation is still reachable via the resume picker (`ctrl+r`). Broadcast over the daemon so every attached TUI resets in lockstep (KOB-55).

## [0.5.3] - 2026-05-10

### Fixed

- **Workspace focus reliably returns to the chat input** — clicking a chat-tab chip, re-clicking inside the workspace, or interacting with the MessageList while the workspace pane was already focused used to leave native opentui focus on whatever child the click landed on, so the composer textarea silently stopped receiving keystrokes; the focus context now ticks a refocus signal on every `setFocused` call (same-pane included) and the composer mirrors it, so the textarea grabs focus on every workspace focus event whenever a chat tab is active (KOB-53).

## [0.5.2] - 2026-05-10

### Fixed

- **MCP bridge config entry now points at the kobe CLI, not whatever `argv[1]` happens to be** — kobe's RPC bridge writes an MCP config so every spawned Claude Code subprocess gets the `kobe_spawn_task` / `kobe_list_tasks` / `kobe_get_task` / `kobe_send_message` tools, but the entry path was derived from `process.argv[1]`. In daemon mode that pointed at `kobed.ts mcp-bridge`, which has no such subcommand, so the MCP server exited immediately and no `kobe_*` tools registered. Resolved by anchoring the entry to `cli/index.{ts,js}` via `import.meta.url` regardless of caller (KOB-54).

## [0.5.1] - 2026-05-10

### Added

- **Claude plan utilization in the WORKSPACE header** — a new `Plan 5h X% · 7d Y%` chip sits next to the per-tab context meter, fed by a 60-second daemon-side poller against Anthropic's `/api/oauth/usage` endpoint and broadcast to every attached TUI; reads the OAuth token from claude-code's macOS Keychain entry (or the Linux `~/.claude/.credentials.json` fallback) and stays read-only — when the token is expired or the request fails the chip simply hides, letting the user refresh via `claude` itself (KOB-51).

## [0.5.0] - 2026-05-10

### Added

- **File tree auto-refreshes on disk changes** — a recursive `fs.watch` on the active worktree bumps the refresh tick whenever a file changes, debounced ~200 ms; `.git/` and `node_modules/` are filtered to avoid feedback loops and high-churn noise. The `r` keystroke remains as a manual fallback when the watcher can't attach.
- **Multi-attach chat broadcast** — a fresh task's events now reach every attached TUI, not just the one that spawned it; opening two kobe windows on the same daemon shows the same chat in real time (KOB-36).
- **Per-tab streaming rehydrate on reconnect** — a TUI reattaching to the daemon mid-stream now resumes the in-flight assistant turn instead of waiting for the next message boundary; daemon replays the pending delta buffer keyed by tab.
- **Settings dialog "Restart backend" button** — the kobed daemon can be cycled from inside the TUI without dropping to a shell (KOB-36).
- **`@`-mention file picker** — typing `@` in the composer opens an inline picker scoped to the active task's worktree; selections drop a real path into the prompt that the engine can resolve.
- **Deeper assistant markdown** — tables, task lists, horizontal rules, and autolinks now render in the transcript (KOB-47).
- **Pasted-image refs collapse to `[Image #N]` in transcript** — user messages display the image attachments as `[Image #1]` / `[Image #2]` instead of raw `@/abs/path` strings while the engine still receives the full path on submit and history recall.
- **Model picker maps claude-code aliases to canonical labels** — `opus`, `sonnet`, `haiku` (and `[1m]` variants) pinned in `~/.claude/settings.json` now show their friendly label (`opus 4.7`, …) in the composer footer; the alias is still what gets passed to `claude --model`.

### Fixed

- **Cmd vs Alt key split** — Cmd+C on macOS now reaches its own handler instead of being eaten by the Alt-bound mention picker, so terminal-style copy works again (KOB-48).
- **Auto-copy on selection drag-end** — releasing the mouse on a chat selection writes the text to the system clipboard directly, matching native terminals (KOB-48).
- **File tree cursor stays in viewport on j/k scroll** — moving the cursor past the visible window now nudges the scrollbox so the highlighted row stays on-screen.
- **Main-task path normalization** — saved-repo paths now resolve to the git toplevel before tasks attach, so a main task pinned at a subdirectory still finds its worktree.
- **`chat.tab.create` no longer leaks subscriptions** — opening a new tab used to re-subscribe every existing tab, so each delta fired N callbacks after N tabs.
- **`chat.send` accepts empty / continue prompts** — server stops rejecting blank text; the resume-without-prompt path works end-to-end again.
- **`chat.history` pagination** — response now includes `nextBefore` + `hasMore`, so the older-page cursor is actually usable.
- **`peekPendingInput` over the daemon** — a TUI attaching mid-session to a task in `awaiting_input` now sees the pending request and locks the composer; the client hydrates per-task on init and stays in sync via `user_input.request` / `user_input.resolved` events.
- **`kobed restart` no longer races itself** — the relaunch waits for the previous daemon's pid to actually exit (poll `kill -0`) instead of a fixed 150 ms sleep that could trip EADDRINUSE on slow shutdowns.
- **User prompt is broadcast over the wire** — the chat composer used to push the user row into a local signal before calling `runTask`; other attached TUIs missed it and successive assistant turns concatenated into one blob. `runTask` now emits `user.inject` on the per-task event bus so every client sees the user message and the chat reducer re-anchors message boundaries.
- **ESC-interrupt clears "thinking" indicator** — `interruptTask` now dispatches a synthesized `done` after `engine.stop`, so the chat composer flips back to idle instead of staying stuck on the "Harmonizing… (Ns)" loading row.
- **`task.created` / `task.updated` broadcast from `ensureMain`** — clients observing the main-task slot now see it appear in real time on a fresh daemon, not only after the first chat event.
- **`dist` layout matches Bun's LCA-rooted output** — fixes a published-artifact path mismatch that could cause `kobe`/`kobed` shims to miss their entry points.

### Changed

- **`task.updated` payload field renamed `patch` → `task`** — the wire never carried a partial patch (always a full task); the field name now matches.
- **Root `package.json` exposes daemon scripts** — `bun run daemon` / `daemon:stop` / `daemon:restart` / `daemon:status`, plus `dev:test` and `dev:test:reset`, are now available from the monorepo root without `cd packages/kobe`.

## [0.4.0] - 2026-05-10

### Added

- **Context-usage meter in WORKSPACE header** — shows compact `pct · used/window` per tab, derived from streamed `usage` events. Knows about `[1m]` and the standard 200k context windows. The stream parser now picks up `cache_read_input_tokens` / `cache_creation_input_tokens` from `result` frames; chat state keeps `lastUsage` per tab and clears it on each fresh user turn so the meter reflects only the current draw.

## [0.3.0] - 2026-05-10

### Added

- **Resume Claude Code sessions from disk** — kobe reads the same `~/.claude/projects/<encoded-cwd>/*.jsonl` session mirror claude-code uses, lists recent sessions for the task cwd, and exposes a resume flow in the TUI (dialog + keybindings) while the orchestrator forwards `KOBE_RESUME_CWD` and related spawn wiring so resume targets the task worktree. Ships with a new `listSessionsForCwd` engine surface; `bun run dev:test` seeds sample session JSONL under the isolated fixture home.
- **Richer chat markdown** — headings, ordered lists, blockquotes, and links render in the assistant transcript (KOB-28).
- **File tree diff stats** — each changed file row shows `+/-` line counts from `git diff --numstat` (KOB-24).
- **Chat tab rename (`ctrl+r`) and sidebar pin (`shift+p`)** — rename the active chat tab from the keyboard; pin a non-main task to the top of the sidebar list (KOB-23).
- **Image paste in the composer** — bracketed-paste + `ctrl+v` path forwards image attachments into the prompt flow (KOB-22).
- **Pinned `main` task per saved repo** — a long-lived main-line task without allocating a worktree for quick prompts against the repo root (KOB-15).
- **MCP bridge for spawned Claude** — kobe can expose itself to child `claude` instances via MCP so in-session tooling can call back into the orchestrator (KOB-30).

### Changed

- **shift+tab is now a two-mode toggle: `default` ↔ `plan`.** kobe's `default` is the trusted-bypass mode — the engine maps it to claude-code's `bypassPermissions` at spawn time. Rationale: `claude -p` has no interactive permission protocol, so the only meaningful CLI choice is "auto-deny outside cwd" or "auto-approve everything," and `acceptEdits` is moot in non-interactive mode. The kobe-side `PermissionMode` type union is now just `"default" | "plan"`; persisted state with the legacy values (`acceptEdits` / `bypassPermissions` / `auto` / `dontAsk`) loads as `default`.

### Fixed

- **`esc` during streaming interrupts the in-flight turn** instead of only jumping back to the sidebar when the user expects escape to cancel the active model turn.
- **Tool-use rows fold by default** with click-to-expand so long tool output does not dominate the transcript (KOB-26).
- **Thinking spinner uses a fixed glyph column** so the verb label stops jittering as frames update.
- **File tree** — `+/-` stat columns align via `padStart` to the widest sibling; **row click / file-open focus** no longer strands focus in the wrong pane (KOB-25); path normalization **honours `$HOME` over Bun's cached homedir()** so tilde-style paths behave consistently.
- **Embedded terminal** stops forwarding global kobe chords wholesale to the PTY so global escape hatches keep working even inside nested shells.
- **Preview** — `ctrl+w` closes/delegates correctly when an external tab strip owns the file list; **git toplevel resolution** before cat/diff fixes subdir-pinned main tasks that could not open files (KOB-19).
- **Chat / workspace** — internal `activeTabId` re-syncs from the orchestrator on every tick (KOB-21); **workspace file preview** reuses a single shared tab instead of accumulating duplicates (KOB-20); **subagent stream events** tagged with `parent_tool_use_id` stay out of the parent transcript (KOB-18).
- **`tasks.json` persistence** serialises concurrent `save()` calls so temp-file rename races cannot throw `ENOENT`.

### Distribution / Devx

- **`bun run dev:test` mock home** keeps fixtures under `.dev-fixture/` with `KOBE_HOME_DIR` isolation so local runs do not scribble over real `~/.kobe`.
- **`node-pty` semver range** widened to `^1.1.0` with lockfile housekeeping for CI/agents.

## [0.2.2] - 2026-05-10

### Added

- **`bypassPermissions` is now reachable via the shift+tab cycler.** Cycle order extended: default → acceptEdits → plan → bypass → default. The `bypass` mode passes `--permission-mode bypassPermissions` to claude-code (equivalent to `--dangerously-skip-permissions`), which skips ALL tool-permission gates including the worktree-cwd boundary that otherwise blocks reads of files like `~/.zshrc`. Same approach `opcode` takes — claude-code in `-p` mode has no interactive permission protocol, so the choice is "auto-deny outside cwd" or "auto-approve everything." Footer badge renders "bypass permissions" in warning color so the loose-permissions state is unmistakable.

### Why no interactive approve UI

Researched the alternative: a `--permission-prompt-tool <name>` MCP-server bridge that delegates every tool-permission decision back to a kobe-hosted MCP. That's a 2-3 day build (write the MCP server, register it on every spawn, route the request events through to a UI panel, handle async approve/deny replies) and not a great fit for the user's "I just want it to work" baseline. Cycling to `bypass` mode is the pragmatic answer — same trade opcode made.

## [0.2.1] - 2026-05-10

### Added

- **Default model now reads from `~/.claude/settings.json`** — kobe honors the `model` key the user set via claude-code's own `/model` command (or a workplace policy file at the same path). Resolution order matches claude-code's `getUserSpecifiedModelSetting()`: per-task pin → settings.json `model` → hardcoded fallback. The hardcoded fallback bumped to **`claude-opus-4-7[1m]`** (Opus 4.7 with 1M context) — long-context variant aligned with kobe's "task = sustained worktree of work" model.
- **1M-context Opus 4.7 + Sonnet 4.6** entries added to the model picker (`opus 4.7 (1M)`, `sonnet 4.6 (1M)`). Same `[1m]` suffix syntax claude-code uses (`refs/claude-code/src/utils/model/model.ts` `parseUserSpecifiedModel`).

### Fixed

- **Pane focus blurs the chat composer reliably.** ctrl+q (or any ctrl+hjkl pane jump) now goes through a unified `setFocused` in the focus context that explicitly blurs the renderer's currently-focused renderable before flipping the pane signal. Previously Composer's createEffect mirror left a one-tick window where the textarea still owned native input focus and ate keystrokes intended for the new pane.

### Known limitations

- Permission-request UI for tools that hit claude-code's worktree boundary (e.g. reading `~/.zshrc` from a task whose cwd is `.claude/worktrees/<id>`) is not yet surfaced. claude-code in `-p` mode doesn't expose an interactive permission protocol; bridging would require a `permission_prompt_tool` integration. Tracked separately.

## [0.2.0] - 2026-05-10

The chat pane gets mid-stream queue + steer, the keybinding system gets a proper boundary doc, and modals stop being broken at every viewport size. Plenty of UX polish on top.

### Added

- **Mid-stream submission modes** in chat. `enter` while a turn is streaming queues the prompt (drained automatically when the turn ends); `ctrl+enter` interrupts the in-flight subprocess and dispatches the new prompt against the same session id. Mirrors claude-code's `'now' / 'next' / 'later'` priority shape from the refs source. Queue is rendered above the composer with a `[x]` cancel chip per entry, capped at 4 visible rows + `+N more` overflow.
- **Pending approval / question pickers move into the composer slot**. While `ExitPlanMode` / `AskUserQuestion` is awaiting an answer, the picker renders below the chat instead of inline in the transcript; once submitted, the row drops back into the message list as a resolved historical entry. The composer is hidden during the pending state — the picker IS the input.
- **`docs/KEYBINDINGS.md`** — pane-scope rules, the canonical overlap-resolution table, and a decision log explaining how we arrived at the current chord set. Linked from `CLAUDE.md` as a load-bearing read alongside HARNESS.md and PLAN.md.
- **User-installable themes** under `~/.kobe/themes/`. Drop a JSON file with the schema documented in the README; kobe merges it into the theme list at boot. New `kobe theme install <path>` CLI subcommand wires this up. Bundled `claude` theme as the new default for fresh installs.
- **User-pickable focus accent** color (Settings → General). The ▌ marker / pane-title / focused border all read `theme.focusAccent` so the focus signal reads as one visual instead of three different hues across panes.
- **Settings dialog two-level keyboard nav**: sidebar level (j/k cycles General/Dev), body level (j/k cycles theme rows + the transparent-bg toggle + Dev's Reset button). h/l switch level. Every body row is reachable from the keyboard now — previously the Transparent toggle could only be reached via the bare `t` shortcut.
- **`s` keybinding** for settings (sidebar focus). Mirrors the `n` / `q` sidebar-only single-letter chord pattern. `ctrl+,` still works globally.

### Changed

- **Pane focus chord moved from `ctrl+1..4` to `ctrl+hjkl`** (vim position: h=tasks / j=workspace / k=files / l=terminal). Reason: ctrl+digit needs CSI-u + tmux extended-keys + a terminal that doesn't have iTerm's ctrl+1 quirk; alt+digit gets eaten by macOS launchers like Raycast. ctrl+letter chords map to stable C0 control bytes that every terminal sends without negotiation, so the chord works for everyone with zero setup. Pane title bold ordinal updated to show the chord letter (h/j/k/l).
- **Chat tab navigation** moved from `ctrl+1..9` numeric pick to `ctrl+]` / `ctrl+[` cycle (next/prev). Mirrors the sidebar's `[/]` view switch and the files pane's `[/]` tab cycle for a consistent bracket-pair vocabulary across panes.
- **Files pane tabs** (All / Changes / Checks) cycle with `[/]` instead of `1/2/3`. Same bracket-pair pattern.
- **Sidebar header** renamed `kobe` → `TASKS` for parity with the WORKSPACE / FILES / TERMINAL pane titles.
- **`palette.open`** chord moved from `ctrl+k` to `ctrl+p` / `cmd+p` (vscode/Cursor convention) so `ctrl+k` is free for pane focus.
- **`task.new`** chord moved from global `ctrl+n` to sidebar-scoped bare `n`. **`app.quit`** moved from global `ctrl+q` / `ctrl+shift+q` to sidebar-scoped bare `q`. **`focus.sidebar`** (workspace-scoped `ctrl+q`) added so the user can escape from the chat composer back to the task list. The sidebar's bare letter chords were a long-standing UX wish; before, single-letter chords would have collided with composer typing.
- **Modals** now cap at viewport height with overflow scrolling; no more F1 help dialog falling off the bottom of the terminal. Default modal width bumped from 60 → 80 cols, with a new `small` (50) size for confirms. New-task dialog reorganised to a picker-first flow: current cwd + saved repos as the primary surface, custom path input as a secondary fallback. Modals stay opaque even in transparent mode.
- **Pane title alignment**: all four pane titles sit at row 1 col 2 with a bold leading ordinal (h/j/k/l). Removed the `▌` focus marker — the focus-tracking color on the ordinal does the same job with less visual noise.
- **Default theme** is `claude` (terracotta accent on warm neutrals); existing users keep their pinned theme.

### Fixed

- **Single Ctrl+C no longer kills kobe.** First press copies the selection (or arms a quit with a "Press Ctrl+C again to exit" warning chip in the status bar); second within 1.5s exits. Matches claude-code / fish / ipython muscle memory.
- **Quitting kobe restores the host terminal cleanly** — previously `process.exit(0)` skipped opentui's teardown, leaving mouse tracking enabled (host shell received SGR mouse events from every cursor move) and alt-screen unrestored.
- **Engine subprocess + tasks.json races**: queue dispatch now serializes via a `draining` lock so concurrent drains can't race on the same session id, and `pumpEvents` buffers the terminal `done`/`error` event until after `engine.stop` + `store.update` complete — prevents `SessionRegistry: duplicate sessionId` and `ENOENT rename tasks.json.tmp` when the user spam-types prompts mid-stream.
- **Streaming cursor `▏` removed** from assistant rows — claude-code itself doesn't render one and ours rendered as a stray `|` on its own line. The thinking spinner above the composer is now the canonical "turn in flight" affordance.
- **Thinking spinner** moved out of the scrolling transcript and pinned just above the composer (mirrors claude-code's `SpinnerWithVerb` placement). No more order-jumping when the list grows.
- **Don't steal focus from the sidebar on cold boot** when the workspace has a pre-pending prompt — composer focus only takes over after the user actively engages with the chat.
- **iTerm2 ctrl+1 quirk** documented in KEYBINDINGS.md (TLDR: ctrl digits 1 / 9 / 0 fall through to bare bytes even with CSI-u enabled). Avoided altogether by the move to ctrl+hjkl.

### Distribution / Devx

- Behavior tests stay local-only (need tmux + node-pty terminal sizing). CI runs typecheck + unit tests + build only.
- New `linear` agent skill + Linear CLI conventions documented for team workflows.

## [0.1.1] - 2026-05-09

Post-ship hygiene + the test-coverage layer that 0.1.0 was missing. No user-facing behavior changes; pure correctness + safety net.

### Added

- **CI gate** at `.github/workflows/ci.yml` — typecheck + unit tests + build run on every push to main and every PR. Concurrency group cancels in-flight runs for older pushes on the same branch.
- **Approval-flow behavior tests** (`test/behavior/approval-flow.test.ts`) covering both ExitPlanMode plan approval and AskUserQuestion multi-choice picker — picker rendering, composer lock, AND the click-through resolve path that emits the synthetic resume prompt. New `/respond` HTTP endpoint on the in-process fake-engine server + `peekPendingInput()` orchestrator accessor surface the test seam without faking SGR mouse events.
- **Settings → theme switch behavior test** (`test/behavior/settings-theme-switch.test.ts`) — opens the dialog via the canonical shortcut, switches theme, asserts the KV store persisted the new active theme.
- **Crash recovery behavior test** (`test/behavior/crash-recovery.test.ts`) — simulates an engine `error` event mid-stream, asserts kobe stays alive, the error row renders with the right prefix, and the composer unlocks for retry. Symmetric clean-`done` regression guard included.

### Fixed

- Test helpers' `scriptEngine` no longer set `Content-Length` from `body.length` — the char-count was wrong for any multi-byte UTF-8 payload (em-dash etc), so the in-process server read fewer bytes than `JSON.parse` expected and the request handler never ran. `fetch` now computes the byte length itself.
- Defensive: `Composer`'s `resolvePlaceholder` now honors `noTaskMessage` so the textarea-vs-fallback branch stays in sync if rendering ever flips back to letting the textarea show the placeholder.

## [0.1.0] - 2026-05-09

### Added

- Resizable pane splitters: drag the borders with the mouse (hover affordance + mode-tinted handle) or use `ctrl+=` / `ctrl+-` to resize the focused pane from the keyboard. Sizes persist across launches via KV.
- Settings dialog (`,` from any non-input pane, `ctrl+,` always-on) with **General** (theme picker, transparent-bg toggle) and **Dev** (one-click reset of the persisted UI state) sections.
- New `conductor` theme — Conductor-inspired monochrome with a desaturated steel-blue accent. Default for fresh installs; existing users keep their pinned theme until they switch.
- Transparent-bg toggle pairs with any theme — when on, the host terminal's wallpaper / opacity / image shows through everywhere except the composer body, which keeps `theme.backgroundElement` so messages stay legible.
- Multi-tab chat: each task hosts N independent Claude Code sessions on a shared worktree, switchable via the workspace tab strip.
- Slash command dropdown: bundled claude-code commands (filtered to those that run under `claude -p`) merged with the user's own `.claude/{commands,skills}/*.md` (project-first, global fallback, ported from vibe-kanban's discovery loop). Tab completes the highlighted entry; user-defined commands carry a `(user)` tag.
- Per-task tool-permission mode — `shift+tab` in the composer cycles `default → acceptEdits → plan → default`, forwarded as `claude --permission-mode <mode>` on every spawn / resume. Mode badge in the composer footer; rail tints with the active mode.
- Per-task model picker in the composer footer — click the model label to pick from a fixed Anthropic model list (opus 4.7 / sonnet 4.6 / haiku 4.5). Persisted on `Task.model` and routed through `--model <id>`.
- Inline approval flows: `ExitPlanMode` renders the plan with Approve / Reject buttons; `AskUserQuestion` renders as a multi-choice picker row. The composer locks while a request is pending and the underlying subprocess is killed cleanly when the user dismisses.
- Sidebar gains `[r] rename` for the cursor task (matching the existing `[d] delete` / `[a] archive` chord vocabulary). Bare `n` for new task is now scoped to sidebar focus (unambiguous with composer typing); `ctrl+n` still opens new-task from anywhere.
- New-task dialog dropped its first-prompt field — orchestrator back-fills the title from the user's first composer submit. Repo input remembers the last-used path; the branch picker is windowed + type-to-filter so a repo with 80+ branches no longer pushes the rest of the dialog off-screen.
- Topbar update chip — clickable, opens a release-notes dialog with the install command. 6 h disk cache, 3 s timeout, silent on failure. Suppressed entirely under `KOBE_DEV=1`.
- Tonal gradient layout — sidebar and right rail paint `theme.backgroundPanel`, chat body keeps the renderer's `theme.background` (one tone darker). Standard IDE convention: auxiliary rails lifted, work area sunken.
- claude-code XML wrappers (`<command-name>`, `<local-command-stdout>`, `<local-command-stderr>`) parse + render as styled command rows instead of raw markup, mirroring `UserLocalCommandOutputMessage` (with `extractTag` lifted verbatim from upstream).
- Auto-derived branch names when worktree allocation is lazy — uses a claude-derived slug instead of generic `kobe/<id>`, surfaced in chat as a dim system row so the user sees what was picked.

### Changed

- `opencode` theme accent desaturated from saturated purple `#9d7cd8` to muted steel-blue `#7da5c8`; the dark bg ramp (`darkStep1`–`darkStep8`) lifted ~12 units for better panel-vs-chat separation. Identity tokens (text, primary orange, diff colors) unchanged.
- Removed the only hardcoded color literal in the source tree (`CLAUDE_ORANGE`) — the assistant marker is now `theme.accent` and respects every theme.
- Composer chrome lift: left-rail accent, element fill around the textarea, and an inline footer carrying the action hint + permission-mode badge + clickable model picker. Mirrors opencode's prompt layout.
- Chat tabs folded into the workspace `CenterTabStrip` next to file tabs — one place for everything that switches the workspace view.
- Worktree path locked to `<repo>/.claude/worktrees/<task-id>/` with a doc scrub of the old `.kobe/worktrees/` references so drift can't re-introduce the wrong path.

### Fixed

- Subprocess no longer leaks when a pending user-input tool is interrupted; the composer locks while input is pending and unlocks cleanly on resolve / dismiss.
- Lazy worktree allocation no longer collides on the auto-branch slug (suffixed with the task-id tail); chat-header dedup fixes the "task — title" appearing twice.
- New-task dialog validates the repo path is actually a git repo before creating, and strips stray newlines from pasted inputs.
- Chat-store reconciler hardened against out-of-order engine events.
- Slash-command dropdown no longer surfaces commands that immediately fail under `claude -p` (`local-jsx` and non-interactive-disabled commands filtered at extraction time).

## [0.0.1] - 2026-05-09

Initial public release.

### Added

- TUI orchestrator for Claude Code with a five-pane Conductor-style layout: sidebar (tasks), workspace (chat + per-task file tabs), file tree, preview, and embedded terminal.
- Per-task git worktrees with restore-across-runs persistence (active task + center tab survive reopen).
- Multi-line composer with paste, history, and slash commands inherited from claude-code; `shift+tab` cycles permission modes.
- Inline PR creation: a chat-side button injects the PR-instructions prompt into the active task and routes the resulting PR through the orchestrator's pipeline.
- Embedded terminal pane backed by tmux (one session per task, resized to match the rendered area, native cursor positioned via the renderer).
- Sidebar Working / Archives split with archive + delete flows; delete tears down the worktree, chat history, and task entry.
- Resizable pane splitters (drag the borders) with hover affordance.
- TopBar with brand version, repo + branch context, and a `Create PR` action.
- `ctrl+1234` for direct pane focus, `ctrl+q` to detach back to the sidebar from any pane, `?` for help dialog, `q` to quit.
- Theme system with a default `tokyonight` preset.
- Behavior-test harness (Stream 0.4) plus per-pane and end-to-end behavior tests covering chat, sidebar, filetree, preview, terminal, PR flow, composer, and task lifecycle.

### Distribution

- Published as `@sma1lboy/kobe` on npm with a `bin/kobe` entry, so `npm i -g @sma1lboy/kobe` (or `bunx @sma1lboy/kobe`) produces a runnable CLI.
- Production bundler at `scripts/build.ts` registers `@opentui/solid`'s Bun plugin (CLI `bun build` can't take plugins via flags) and chmods the output executable.
- Background npm-registry version check at `src/version.ts` — 3s timeout, 6h disk cache, silent on failure. TopBar shows an `↑ vX.Y.Z available` chip when a newer version is published.
- GitHub Actions release workflow at `.github/workflows/release.yml`: pushing a `vX.Y.Z` tag runs typecheck + unit tests + build, asserts the tag matches `package.json`, extracts the matching CHANGELOG section, then `npm publish --provenance` and creates the GitHub release with `dist/index.js` attached.

### Tooling

- Vendored the `changelog-generator` skill from [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills) at `.claude/skills/changelog-generator/SKILL.md` so contributors using Claude Code can ask it to draft new `[Unreleased]` entries from the commit log.
