# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How to update

1. Land your change as usual.
2. Add a bullet under `## [Unreleased]` describing it user-facingly
   (one line, present tense — "Add X", "Fix Y").
3. When cutting a release: rename the `[Unreleased]` section to
   `[X.Y.Z] - YYYY-MM-DD`, add a fresh empty `[Unreleased]` above it,
   bump `package.json`, commit, then push the matching `vX.Y.Z` tag.
   The release workflow extracts the section for the tag's version
   and uses it as the GitHub release body.

---

## [Unreleased]

## [0.2.1] - 2026-05-10

### Added

- **Default model now reads from `~/.claude/settings.json`** — kobe
  honors the `model` key the user set via claude-code's own `/model`
  command (or a workplace policy file at the same path). Resolution
  order matches claude-code's `getUserSpecifiedModelSetting()`:
  per-task pin → settings.json `model` → hardcoded fallback. The
  hardcoded fallback bumped to **`claude-opus-4-7[1m]`** (Opus 4.7
  with 1M context) — long-context variant aligned with kobe's "task
  = sustained worktree of work" model.
- **1M-context Opus 4.7 + Sonnet 4.6** entries added to the model
  picker (`opus 4.7 (1M)`, `sonnet 4.6 (1M)`). Same `[1m]` suffix
  syntax claude-code uses (`refs/claude-code/src/utils/model/model.ts`
  `parseUserSpecifiedModel`).

### Fixed

- **Pane focus blurs the chat composer reliably.** ctrl+q (or any
  ctrl+hjkl pane jump) now goes through a unified `setFocused` in
  the focus context that explicitly blurs the renderer's currently-
  focused renderable before flipping the pane signal. Previously
  Composer's createEffect mirror left a one-tick window where the
  textarea still owned native input focus and ate keystrokes
  intended for the new pane.

### Known limitations

- Permission-request UI for tools that hit claude-code's worktree
  boundary (e.g. reading `~/.zshrc` from a task whose cwd is
  `.claude/worktrees/<id>`) is not yet surfaced. claude-code in
  `-p` mode doesn't expose an interactive permission protocol;
  bridging would require a `permission_prompt_tool` integration.
  Tracked separately.

## [0.2.0] - 2026-05-10

The chat pane gets mid-stream queue + steer, the keybinding system
gets a proper boundary doc, and modals stop being broken at every
viewport size. Plenty of UX polish on top.

### Added

- **Mid-stream submission modes** in chat. `enter` while a turn is
  streaming queues the prompt (drained automatically when the turn
  ends); `ctrl+enter` interrupts the in-flight subprocess and
  dispatches the new prompt against the same session id. Mirrors
  claude-code's `'now' / 'next' / 'later'` priority shape from the
  refs source. Queue is rendered above the composer with a `[x]`
  cancel chip per entry, capped at 4 visible rows + `+N more`
  overflow.
- **Pending approval / question pickers move into the composer
  slot**. While `ExitPlanMode` / `AskUserQuestion` is awaiting an
  answer, the picker renders below the chat instead of inline in
  the transcript; once submitted, the row drops back into the
  message list as a resolved historical entry. The composer is
  hidden during the pending state — the picker IS the input.
- **`docs/KEYBINDINGS.md`** — pane-scope rules, the canonical
  overlap-resolution table, and a decision log explaining how we
  arrived at the current chord set. Linked from `CLAUDE.md` as a
  load-bearing read alongside HARNESS.md and PLAN.md.
- **User-installable themes** under `~/.kobe/themes/`. Drop a
  JSON file with the schema documented in the README; kobe merges
  it into the theme list at boot. New `kobe theme install <path>`
  CLI subcommand wires this up. Bundled `claude` theme as the new
  default for fresh installs.
- **User-pickable focus accent** color (Settings → General). The
  ▌ marker / pane-title / focused border all read `theme.focusAccent`
  so the focus signal reads as one visual instead of three different
  hues across panes.
- **Settings dialog two-level keyboard nav**: sidebar level (j/k
  cycles General/Dev), body level (j/k cycles theme rows + the
  transparent-bg toggle + Dev's Reset button). h/l switch level.
  Every body row is reachable from the keyboard now — previously
  the Transparent toggle could only be reached via the bare `t`
  shortcut.
- **`s` keybinding** for settings (sidebar focus). Mirrors the
  `n` / `q` sidebar-only single-letter chord pattern. `ctrl+,`
  still works globally.

### Changed

- **Pane focus chord moved from `ctrl+1..4` to `ctrl+hjkl`** (vim
  position: h=tasks / j=workspace / k=files / l=terminal). Reason:
  ctrl+digit needs CSI-u + tmux extended-keys + a terminal that
  doesn't have iTerm's ctrl+1 quirk; alt+digit gets eaten by
  macOS launchers like Raycast. ctrl+letter chords map to stable
  C0 control bytes that every terminal sends without negotiation,
  so the chord works for everyone with zero setup. Pane title
  bold ordinal updated to show the chord letter (h/j/k/l).
- **Chat tab navigation** moved from `ctrl+1..9` numeric pick to
  `ctrl+]` / `ctrl+[` cycle (next/prev). Mirrors the sidebar's
  `[/]` view switch and the files pane's `[/]` tab cycle for a
  consistent bracket-pair vocabulary across panes.
- **Files pane tabs** (All / Changes / Checks) cycle with `[/]`
  instead of `1/2/3`. Same bracket-pair pattern.
- **Sidebar header** renamed `kobe` → `TASKS` for parity with the
  WORKSPACE / FILES / TERMINAL pane titles.
- **`palette.open`** chord moved from `ctrl+k` to `ctrl+p` /
  `cmd+p` (vscode/Cursor convention) so `ctrl+k` is free for pane
  focus.
- **`task.new`** chord moved from global `ctrl+n` to sidebar-scoped
  bare `n`. **`app.quit`** moved from global `ctrl+q` /
  `ctrl+shift+q` to sidebar-scoped bare `q`. **`focus.sidebar`**
  (workspace-scoped `ctrl+q`) added so the user can escape from
  the chat composer back to the task list. The sidebar's bare
  letter chords were a long-standing UX wish; before, single-letter
  chords would have collided with composer typing.
- **Modals** now cap at viewport height with overflow scrolling;
  no more F1 help dialog falling off the bottom of the terminal.
  Default modal width bumped from 60 → 80 cols, with a new
  `small` (50) size for confirms. New-task dialog reorganised to
  a picker-first flow: current cwd + saved repos as the primary
  surface, custom path input as a secondary fallback. Modals stay
  opaque even in transparent mode.
- **Pane title alignment**: all four pane titles sit at row 1 col 2
  with a bold leading ordinal (h/j/k/l). Removed the `▌` focus
  marker — the focus-tracking color on the ordinal does the same
  job with less visual noise.
- **Default theme** is `claude` (terracotta accent on warm
  neutrals); existing users keep their pinned theme.

### Fixed

- **Single Ctrl+C no longer kills kobe.** First press copies the
  selection (or arms a quit with a "Press Ctrl+C again to exit"
  warning chip in the status bar); second within 1.5s exits.
  Matches claude-code / fish / ipython muscle memory.
- **Quitting kobe restores the host terminal cleanly** — previously
  `process.exit(0)` skipped opentui's teardown, leaving mouse
  tracking enabled (host shell received SGR mouse events from
  every cursor move) and alt-screen unrestored.
- **Engine subprocess + tasks.json races**: queue dispatch now
  serializes via a `draining` lock so concurrent drains can't
  race on the same session id, and `pumpEvents` buffers the
  terminal `done`/`error` event until after `engine.stop` +
  `store.update` complete — prevents `SessionRegistry: duplicate
  sessionId` and `ENOENT rename tasks.json.tmp` when the user
  spam-types prompts mid-stream.
- **Streaming cursor `▏` removed** from assistant rows — claude-code
  itself doesn't render one and ours rendered as a stray `|` on
  its own line. The thinking spinner above the composer is now
  the canonical "turn in flight" affordance.
- **Thinking spinner** moved out of the scrolling transcript and
  pinned just above the composer (mirrors claude-code's
  `SpinnerWithVerb` placement). No more order-jumping when the
  list grows.
- **Don't steal focus from the sidebar on cold boot** when the
  workspace has a pre-pending prompt — composer focus only takes
  over after the user actively engages with the chat.
- **iTerm2 ctrl+1 quirk** documented in KEYBINDINGS.md (TLDR: ctrl
  digits 1 / 9 / 0 fall through to bare bytes even with CSI-u
  enabled). Avoided altogether by the move to ctrl+hjkl.

### Distribution / Devx

- Behavior tests stay local-only (need tmux + node-pty terminal
  sizing). CI runs typecheck + unit tests + build only.
- New `linear` agent skill + Linear CLI conventions documented for
  team workflows.

## [0.1.1] - 2026-05-09

Post-ship hygiene + the test-coverage layer that 0.1.0 was missing.
No user-facing behavior changes; pure correctness + safety net.

### Added

- **CI gate** at `.github/workflows/ci.yml` — typecheck + unit tests
  + build run on every push to main and every PR. Concurrency group
  cancels in-flight runs for older pushes on the same branch.
- **Approval-flow behavior tests** (`test/behavior/approval-flow.test.ts`)
  covering both ExitPlanMode plan approval and AskUserQuestion
  multi-choice picker — picker rendering, composer lock, AND the
  click-through resolve path that emits the synthetic resume prompt.
  New `/respond` HTTP endpoint on the in-process fake-engine server
  + `peekPendingInput()` orchestrator accessor surface the test seam
  without faking SGR mouse events.
- **Settings → theme switch behavior test**
  (`test/behavior/settings-theme-switch.test.ts`) — opens the dialog
  via the canonical shortcut, switches theme, asserts the KV store
  persisted the new active theme.
- **Crash recovery behavior test** (`test/behavior/crash-recovery.test.ts`) —
  simulates an engine `error` event mid-stream, asserts kobe stays
  alive, the error row renders with the right prefix, and the
  composer unlocks for retry. Symmetric clean-`done` regression
  guard included.

### Fixed

- Test helpers' `scriptEngine` no longer set `Content-Length` from
  `body.length` — the char-count was wrong for any multi-byte UTF-8
  payload (em-dash etc), so the in-process server read fewer bytes
  than `JSON.parse` expected and the request handler never ran.
  `fetch` now computes the byte length itself.
- Defensive: `Composer`'s `resolvePlaceholder` now honors
  `noTaskMessage` so the textarea-vs-fallback branch stays in sync
  if rendering ever flips back to letting the textarea show the
  placeholder.

## [0.1.0] - 2026-05-09

### Added

- Resizable pane splitters: drag the borders with the mouse (hover
  affordance + mode-tinted handle) or use `ctrl+=` / `ctrl+-` to
  resize the focused pane from the keyboard. Sizes persist across
  launches via KV.
- Settings dialog (`,` from any non-input pane, `ctrl+,` always-on)
  with **General** (theme picker, transparent-bg toggle) and **Dev**
  (one-click reset of the persisted UI state) sections.
- New `conductor` theme — Conductor-inspired monochrome with a
  desaturated steel-blue accent. Default for fresh installs;
  existing users keep their pinned theme until they switch.
- Transparent-bg toggle pairs with any theme — when on, the host
  terminal's wallpaper / opacity / image shows through everywhere
  except the composer body, which keeps `theme.backgroundElement`
  so messages stay legible.
- Multi-tab chat: each task hosts N independent Claude Code sessions
  on a shared worktree, switchable via the workspace tab strip.
- Slash command dropdown: bundled claude-code commands (filtered to
  those that run under `claude -p`) merged with the user's own
  `.claude/{commands,skills}/*.md` (project-first, global fallback,
  ported from vibe-kanban's discovery loop). Tab completes the
  highlighted entry; user-defined commands carry a `(user)` tag.
- Per-task tool-permission mode — `shift+tab` in the composer
  cycles `default → acceptEdits → plan → default`, forwarded as
  `claude --permission-mode <mode>` on every spawn / resume. Mode
  badge in the composer footer; rail tints with the active mode.
- Per-task model picker in the composer footer — click the model
  label to pick from a fixed Anthropic model list (opus 4.7 /
  sonnet 4.6 / haiku 4.5). Persisted on `Task.model` and routed
  through `--model <id>`.
- Inline approval flows: `ExitPlanMode` renders the plan with
  Approve / Reject buttons; `AskUserQuestion` renders as a
  multi-choice picker row. The composer locks while a request is
  pending and the underlying subprocess is killed cleanly when the
  user dismisses.
- Sidebar gains `[r] rename` for the cursor task (matching the
  existing `[d] delete` / `[a] archive` chord vocabulary). Bare
  `n` for new task is now scoped to sidebar focus (unambiguous
  with composer typing); `ctrl+n` still opens new-task from
  anywhere.
- New-task dialog dropped its first-prompt field — orchestrator
  back-fills the title from the user's first composer submit.
  Repo input remembers the last-used path; the branch picker is
  windowed + type-to-filter so a repo with 80+ branches no longer
  pushes the rest of the dialog off-screen.
- Topbar update chip — clickable, opens a release-notes dialog
  with the install command. 6 h disk cache, 3 s timeout, silent
  on failure. Suppressed entirely under `KOBE_DEV=1`.
- Tonal gradient layout — sidebar and right rail paint
  `theme.backgroundPanel`, chat body keeps the renderer's
  `theme.background` (one tone darker). Standard IDE convention:
  auxiliary rails lifted, work area sunken.
- claude-code XML wrappers (`<command-name>`,
  `<local-command-stdout>`, `<local-command-stderr>`) parse + render
  as styled command rows instead of raw markup, mirroring
  `UserLocalCommandOutputMessage` (with `extractTag` lifted
  verbatim from upstream).
- Auto-derived branch names when worktree allocation is lazy —
  uses a claude-derived slug instead of generic `kobe/<id>`,
  surfaced in chat as a dim system row so the user sees what was
  picked.

### Changed

- `opencode` theme accent desaturated from saturated purple
  `#9d7cd8` to muted steel-blue `#7da5c8`; the dark bg ramp
  (`darkStep1`–`darkStep8`) lifted ~12 units for better
  panel-vs-chat separation. Identity tokens (text, primary
  orange, diff colors) unchanged.
- Removed the only hardcoded color literal in the source tree
  (`CLAUDE_ORANGE`) — the assistant marker is now `theme.accent`
  and respects every theme.
- Composer chrome lift: left-rail accent, element fill around the
  textarea, and an inline footer carrying the action hint +
  permission-mode badge + clickable model picker. Mirrors
  opencode's prompt layout.
- Chat tabs folded into the workspace `CenterTabStrip` next to
  file tabs — one place for everything that switches the workspace
  view.
- Worktree path locked to `<repo>/.claude/worktrees/<task-id>/`
  with a doc scrub of the old `.kobe/worktrees/` references so
  drift can't re-introduce the wrong path.

### Fixed

- Subprocess no longer leaks when a pending user-input tool is
  interrupted; the composer locks while input is pending and
  unlocks cleanly on resolve / dismiss.
- Lazy worktree allocation no longer collides on the auto-branch
  slug (suffixed with the task-id tail); chat-header dedup fixes
  the "task — title" appearing twice.
- New-task dialog validates the repo path is actually a git repo
  before creating, and strips stray newlines from pasted inputs.
- Chat-store reconciler hardened against out-of-order engine events.
- Slash-command dropdown no longer surfaces commands that
  immediately fail under `claude -p` (`local-jsx` and
  non-interactive-disabled commands filtered at extraction time).

## [0.0.1] - 2026-05-09

Initial public release.

### Added

- TUI orchestrator for Claude Code with a five-pane Conductor-style
  layout: sidebar (tasks), workspace (chat + per-task file tabs),
  file tree, preview, and embedded terminal.
- Per-task git worktrees with restore-across-runs persistence
  (active task + center tab survive reopen).
- Multi-line composer with paste, history, and slash commands
  inherited from claude-code; `shift+tab` cycles permission modes.
- Inline PR creation: a chat-side button injects the PR-instructions
  prompt into the active task and routes the resulting PR through
  the orchestrator's pipeline.
- Embedded terminal pane backed by tmux (one session per task,
  resized to match the rendered area, native cursor positioned via
  the renderer).
- Sidebar Working / Archives split with archive + delete flows;
  delete tears down the worktree, chat history, and task entry.
- Resizable pane splitters (drag the borders) with hover affordance.
- TopBar with brand version, repo + branch context, and a
  `Create PR` action.
- `ctrl+1234` for direct pane focus, `ctrl+q` to detach back to the
  sidebar from any pane, `?` for help dialog, `q` to quit.
- Theme system with a default `tokyonight` preset.
- Behavior-test harness (Stream 0.4) plus per-pane and end-to-end
  behavior tests covering chat, sidebar, filetree, preview, terminal,
  PR flow, composer, and task lifecycle.

### Distribution

- Published as `@sma1lboy/kobe` on npm with a `bin/kobe` entry, so
  `npm i -g @sma1lboy/kobe` (or `bunx @sma1lboy/kobe`) produces a
  runnable CLI.
- Production bundler at `scripts/build.ts` registers `@opentui/solid`'s
  Bun plugin (CLI `bun build` can't take plugins via flags) and
  chmods the output executable.
- Background npm-registry version check at `src/version.ts` — 3s
  timeout, 6h disk cache, silent on failure. TopBar shows an
  `↑ vX.Y.Z available` chip when a newer version is published.
- GitHub Actions release workflow at `.github/workflows/release.yml`:
  pushing a `vX.Y.Z` tag runs typecheck + unit tests + build, asserts
  the tag matches `package.json`, extracts the matching CHANGELOG
  section, then `npm publish --provenance` and creates the GitHub
  release with `dist/index.js` attached.

### Tooling

- Vendored the `changelog-generator` skill from
  [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)
  at `.claude/skills/changelog-generator/SKILL.md` so contributors
  using Claude Code can ask it to draft new `[Unreleased]` entries
  from the commit log.
