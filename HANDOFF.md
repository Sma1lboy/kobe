# Handoff — kobe

> Current as of 2026-05-13, after `@sma1lboy/kobe@0.5.22`.
> Keep this file short. Durable rules live in `AGENTS.md`; shipped behavior lives in `packages/kobe/CHANGELOG.md`; architecture detail lives in `docs/ARCHITECTURE.md`.

## Read First

1. `AGENTS.md` — operator manual, hard rules, reference repos, Linear workflow.
2. `CONTEXT.md` — domain vocabulary: Task, Worktree, ChatTab, Session, Orchestrator, Daemon, TUI Client.
3. `docs/DESIGN.md` — product philosophy and state ownership.
4. `docs/ARCHITECTURE.md` — current source-tree map and ownership.
5. `docs/HARNESS.md` — required self-test loop.
6. `packages/kobe/CHANGELOG.md` — exact shipped feature list and current version.

## Current State

- Latest release: `0.5.22` on 2026-05-13.
- Package version source of truth: `packages/kobe/package.json`.
- Release notes source of truth: `packages/kobe/CHANGELOG.md`.
- The default TUI launch uses a per-TUI owned daemon; `kobe --daemon` opts into the shared long-lived daemon and `kobe --single` spells the default explicitly.
- Codex support defaults to the app-server backend, with the exec-stream path retained as fallback.
- Chat tabs are per Task and preserve tab-scoped model configuration when new tabs are created.
- Composer supports shell-command mode, queued prompt editing/retriggering, `@` file mentions, and path chips that open preview tabs.
- Terminal pane uses Bun PTY + headless xterm and can reset the shell with F5.

## Active Follow-Ups

- **tmux skeleton (KOB-213, in flight)** — `kobe` now auto-spawns a `kobe-<id>` tmux session with a 5-pane placeholder layout (panes echo + `tail -f /dev/null`), and the in-process TopBar is gone (tmux `status-left`/`status-right` carry version + branch + `PR:none`). The in-process TUI remains reachable via `KOBE_TMUX=0 bun run dev` (or the new `dev:notmux` script) while subsequent sprints wire `claude`, the daemon, and live status updates into the panes.
- Architecture cleanup remains valuable. Biggest files by current line count: `src/orchestrator/core.ts`, `src/tui/panes/chat/MessageList.tsx`, `src/tui/panes/chat/Composer.tsx`, `src/tui/panes/chat/Chat.tsx`, and `src/tui/panes/chat/store.ts`.
- Prefer extracting deep Modules around real concepts, not line-count slicing. Good candidates: pending user-input lifecycle, PR request flow, chat queue editing, and chat row rendering.
- Behavior tests are local-only and slower/flakier than CI. CI runs typecheck, unit/socket tests, and build; use `bun run test:behavior` when the change is user-visible TUI behavior.
- Release workflow currently emits a GitHub Actions Node 20 deprecation warning for `actions/checkout@v4` / `softprops/action-gh-release@v2`. It is not a release blocker today, but should be cleaned up before GitHub's Node 20 removal window.

## Recent Release Notes

- `0.5.22`: daemon launch flags, composer path preview chips, queued prompt inline editing, Codex reasoning/history hydration fixes, and chat-tab model-effort preservation.
- `0.5.21`: shell-command composer mode, terminal F5 reset, MCP bridge orphan cleanup.
- `0.5.20`: single-point daemon default, Codex app-server backend default, reconnect fixes, and Codex context telemetry cleanup.
