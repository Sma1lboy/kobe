# Handoff — kobe

> Current as of 2026-05-29, after `@sma1lboy/kobe@0.6.4`.
> Keep this file short. Durable rules live in `AGENTS.md`; shipped behavior lives in `packages/kobe/CHANGELOG.md`; architecture detail lives in `docs/ARCHITECTURE.md`.

## Read First

1. `AGENTS.md` — operator manual, hard rules, reference repos, local work-tracking workflow.
2. `packages/kobe/CHANGELOG.md` — canonical shipped behavior. Start at `[0.6.4]`, then read `[0.6.2]` for the direct-tmux reshape details.
3. `docs/KEYBINDINGS.md` — current shortcut model. Important: outer opentui bindings live in `KobeKeymap`, but direct-tmux handover keys live in `src/tui/panes/terminal/tmux.ts`.
4. `docs/design/v2-tmux-handover.md` — historical design intent. It is now partially stale: outer monitor is deprecated and normal startup opens directly into tmux.

## Current State

- Latest release: **`0.6.4` on 2026-05-29**.
- Normal `kobe` startup opens directly into a task's tmux session. The legacy outer opentui monitor still exists only behind `KOBE_OUTER_MONITOR=1` and should be treated as deprecated.
- Product shape is now: one Task = worktree + tmux session. Each ChatTab is a tmux window inside that task session.
- Each ChatTab window has kobe-owned panes: Tasks pane on the left, engine pane, Ops files pane, and shell pane. Engine pane is the only load-bearing pane; Tasks/Ops can be respawned.
- `0.6.4` added automatic stale-pane healing: Tasks/Ops panes are tagged with `@kobe_pane_version`; `ensureSession` respawns stale `kobe tasks` / `kobe ops` panes in place after an upgrade, without closing engine panes or ChatTab windows. `kobe reset` is now a runtime recovery fallback, not the normal update path.
- `0.6.3` added update status in the Tasks pane footer.
- `0.6.2` restored most v0.5 productivity affordances in tmux-native form: Ctrl+[/] window switching, Ctrl+W close ChatTab, F2 rename window, Ctrl+T / Ctrl+Shift+T / prefix T new ChatTab, prefix f quick-create, Tasks pane `s/a/d/o`, Ops pane PR injection row, and ChatTab activity icons.

## Worth Doing Next

### 1. Improve Ops file preview

This is the most valuable next product slice. Current preview opens a full-width tmux window via `kobe ops --preview <file>`. It works, but the workflow is jumpy: enter preview, leave window, lose list context.

Recommended direction:

- Keep the user inside the Ops pane and add an internal preview sub-mode or split: file list above/left, preview below/right.
- Make preview follow selection, with explicit open/lock if auto-follow is too noisy.
- Share one renderer for file content and diffs: code with line numbers, diff with hunk headers, binary/large-file fallback.
- Preserve shortcuts: `enter` preview/open, `a` @mention, `p` create PR, `o` external open, `r` refresh, `[` / `]` All/Changes.
- Avoid reviving the old self-rendered global preview pane; this should be Ops-owned.

Likely files:

- `packages/kobe/src/tui/ops/host.tsx`
- `packages/kobe/src/tui/panes/filetree/FileTree.tsx`
- `packages/kobe/src/tmux/session-layout.ts` (`previewWindowCommand` may become fallback-only)
- `packages/kobe/test/tui/terminal-tmux.test.ts`
- `packages/kobe/test/tmux/session-layout.test.ts`

### 2. Verify stale-pane healing in a real sandbox

Unit coverage is green, but the upgrade story should be manually exercised:

1. `bun run dev:sandbox:reset && bun run dev:sandbox`
2. Create/enter a task and open multiple ChatTabs.
3. Simulate stale panes by clearing or changing `@kobe_pane_version` on Tasks/Ops panes.
4. Re-enter the task and confirm only Tasks/Ops respawn; engine panes and ChatTab windows remain.

Useful tmux probes:

```bash
tmux -L kobe-sandbox list-panes -a -F '#{session_name} #{window_id} #{pane_id} role=#{@kobe_role} version=#{@kobe_pane_version}'
tmux -L kobe-sandbox set-option -p -t %PANE @kobe_pane_version 0.0.0
```

If this fails, fix `healKobePaneVersions()` in `src/tui/panes/terminal/tmux.ts`. Do not make `kobe reset` the default answer again.

### 3. Make reset semantics explicit in docs/doctor output

`kobe reset` should mean runtime reset: daemon/socket/pidfile + kobe tmux sessions, never task/worktree/branch/transcript deletion unless `--hard` explicitly says so. The current implementation is close, but the user-facing explanation should be clearer now that stale-pane healing exists.

Worth adding:

- `kobe doctor` hint: if pane versions are stale, entering the task should self-heal; suggest reset only when tmux/daemon is wedged.
- README section: update path vs reset path.
- Maybe a `kobe doctor` pane-version check that lists stale `@kobe_pane_version` without killing anything.

### 4. Keep work tracking local

Linear filing is no longer part of the agent workflow. Track shipped behavior in `packages/kobe/CHANGELOG.md`, active risks in this handoff, and durable decisions in `docs/`.

## Known Caveats

- `darwin-x64` release asset jobs often sit queued on GitHub Actions long after npm publish succeeds. Do not block npm release on that unless the workflow actually fails.
- `ctrl+shift+t` depends on terminal/tmux modifier forwarding. The reliable fallback is tmux `prefix T`.
- The direct-tmux Tasks pane footer is intentionally hand-maintained; if tmux bindings change, update `src/tui/tasks-pane/host.tsx`, `docs/KEYBINDINGS.md`, and `packages/kobe/README.md` together.
- `refs/` is read-only study material. Never edit it.

## Recent Commits To Know

- `8eb4157` — `chore: release — 0.6.4`
- `4a40db7` — `fix: tmux — self-heal stale kobe panes`
- `05cac41` — `docs: tmux — sync key hints`
- `fa4714c` — `feat: release — 0.6.3`
- `5020829` — `feat: tmux — add engine turn detector`
