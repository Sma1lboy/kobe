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

(no entries — add new bullets here as work lands)

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
