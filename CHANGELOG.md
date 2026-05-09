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
