# Handoff — kobe

> Current as of 2026-05-22, after `@sma1lboy/kobe@0.6.0` (the v0.6 reshape).
> Keep this file short. Durable rules live in `AGENTS.md`; shipped behavior
> lives in `packages/kobe/CHANGELOG.md`; architecture detail lives in
> `docs/ARCHITECTURE.md`.

## Read First

1. `AGENTS.md` — operator manual, hard rules, reference repos, Linear workflow.
2. `docs/design/v2-tmux-handover.md` — the v0.6 reshape design doc.
3. `packages/kobe/CHANGELOG.md` — full v0.6.0 section (what shipped, what's gone, what's reshaping in 0.6.x).
4. `CONTEXT.md` — domain vocabulary (slowly being updated for the reshape; mention drift as you find it).

## Current State

- Latest release: **`0.6.0` on 2026-05-22** — major product reshape, not a patch. See the CHANGELOG `[0.6.0]` section for the full story.
- kobe is now a task-launcher + outer monitor that delegates interactive `claude` to a per-task tmux session (`tmux -L kobe`). Each session is pre-split: claude (left) | kobe-ops (upper right) | shell (lower right).
- The 0.5 self-rendered chat surface is **gone** and not coming back; `claude` / `codex` inside the tmux pane already cover equivalent affordances. The CHANGELOG enumerates the deleted surface so future agents don't accidentally re-litigate it.
- New workspace package: `packages/kobe-ops/` (`@sma1lboy/kobe-ops`). 0.6.0 ships the file watcher; the ops menu lands in 0.6.x.

## Active Follow-Ups

- **KOB-231** (`Step D 续`): cross-task search + batch actions on the outer monitor. Not in 0.6.0.
- **KOB-232** (`0.6.x tracker`): quick-fork / create-PR / file-preview reshaped via the Ops pane (Quick-fork from sidebar, Create-PR + file preview from kobe-ops).
- Architecture cleanup remains valuable. The slim orchestrator (`src/orchestrator/core.ts` is now ~280 lines) + slim daemon (`src/daemon/server.ts`) is the new baseline. If any old chat-driven helper survived the 0.6 cull, surface it and delete.
- CI workflow still emits the Node 20 deprecation warning for `actions/checkout@v4` and `softprops/action-gh-release@v2`. Not a release blocker but worth cleaning before GitHub removes the runner.

## Recent Release Notes

- `0.6.0`: v0.5 chat surface deleted; tmux three-pane model (claude / kobe-ops / shell); outer monitor with live preview + cost dashboard; TaskIndex v3; daemon protocol v2; new `@sma1lboy/kobe-ops` package.
- `0.5.27`: TodoWrite v1 + Task v2 checklists, `/recap` slash + auto-recap, Quick-Fork base branch picker, sidebar polish, removed `ctrl+b` background-tasks manager.
- `0.5.26`: PR lifecycle stale-state fix, Gemini `listCommands` signature.
