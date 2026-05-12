# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How to update

1. Land your change as usual.
2. Add a bullet under `## [Unreleased]` describing it user-facingly (one line, present tense — "Add X", "Fix Y").
3. When cutting a release: rename the `[Unreleased]` section to `[X.Y.Z] - YYYY-MM-DD`, add a fresh empty `[Unreleased]` above it, bump `package.json`, commit, then push the matching `vX.Y.Z` tag. The release workflow extracts the section for the tag's version and uses it as the GitHub release body.

**Style rule — no soft wraps inside bullets or paragraphs.** GitHub renders release bodies with GFM's hard-break extension: every single newline inside a list item or paragraph becomes a `<br>`, which makes the release page look like a narrow column with text broken every ~70 chars. Write each bullet (and each paragraph) as one long line. Editors can soft-wrap at display time. KOB-13 has the rationale; the [`changelog-generator`](../../.claude/skills/changelog-generator/SKILL.md) skill knows this rule.

---

## [Unreleased]

### Changed

- **Worktree directories now use short animal-name slugs** — KOB-65 replaces the 26-character ULID directory names (`<repo>/.claude/worktrees/01KRD9TZAZRDXHRYA23AT2A77R/`) with a Conductor-style pool of ~410 animal names allocated per repo (`<repo>/.claude/worktrees/panda/`), with `-v2`/`-v3` suffixes when a slug is recycled after archive. Branch names and PR titles remain the source of truth for "what this work is"; the slug is just "where it lives on disk", and now fits comfortably in a terminal prompt. Existing ULID-named worktrees keep their dirs and are not migrated; only new tasks get animal slugs.

### Fixed

- **Plan-mode switching is visible again for Claude Code and Codex** — the composer footer now always shows the active engine-owned mode label (`default` / `full access` / `plan mode`) as a clickable control, with shift+tab still cycling the same mode.

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
