# Changelog

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
