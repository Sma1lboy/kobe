# Retiring `app.tsx` — the deprecated outer monitor

`packages/kobe/src/tui/app.tsx` is the v0.6 outer monitor: an opentui shell
(sidebar + live preview + cost dashboard) that predates the inner-first
direction. The product path is `direct.ts` — straight into the tmux
workspace — and the monitor is reachable only via `KOBE_OUTER_MONITOR=1` or
`KOBE_NO_DAEMON=1` (`src/tui/index.tsx`). This doc is the map for the
deletion PRs: what the monitor still owns, what already has a tmux-native
home, what would genuinely be lost, and the ordered slices to deletion.

Honesty rule: a slice may decide to *drop* a capability, but the drop must be
recorded here as a drop — not waved away as "already covered".

## Inventory

| Surface (in `app.tsx` today) | tmux-native home | Verdict |
| --- | --- | --- |
| Task selection + boot restore (daemon active-task primary, kv `lastSelectedTaskId` boot-fallback) | `direct.ts` `chooseInitialTask` — same precedence: daemon active → kv → cwd main → pinned → first | **Covered.** Slice 1 aligned the monitor to the same model and write semantics ("last entered", not "last highlighted"). |
| Task list + actions (n / d / a / r / pin / sort, mouse) | Tasks pane (`tasks-pane/host.tsx`) — same `Sidebar` component, same shared `lib/task-actions` flows | **Covered.** The `Sidebar` component and its lib modules are shared; only app.tsx's wiring dies. |
| New-task flow (`NewTaskDialog`) | Tasks pane `n` → `kobe new-task` full-window page; `kobe quick-task`; `kobe api task create` | **Covered.** All reuse the same dialog/flow modules. |
| No-Task first-run | `direct.ts` zero-task path → `ensureFallbackSession` kobe-home session, Tasks pane, `n` to create | **Covered.** The monitor is *not* the first-run picker anymore. |
| Settings entry | `kobe settings` full-window page, opened from the Tasks pane (`openSettingsTab`) — works in the kobe-home fallback session too | **Covered.** |
| Update-available chip | Tasks pane renders the same daemon `update` channel | **Covered.** |
| Daemon recovery UX | None on either surface. The monitor has no disconnect modal (the KOB-38 "Restart daemon or Quit?" gui contract is unimplemented in both hosts); recovery is `kobe doctor` / `kobe reset` CLI | **Not a blocker.** The monitor adds nothing here. If a gui disconnect modal ever ships, it belongs in `direct.ts`'s attach loop, not here. |
| Live preview (`panes/monitor/LivePreview.tsx` — capture-pane of the selected task without attaching) | None | **Gap.** Inner-first makes "preview before attach" mostly moot (switching sessions *is* the preview), but at-a-glance monitoring of *other* tasks' screens has no replacement. Slice 3 decides drop vs port. |
| Cost dashboard (`panes/monitor/CostDashboard.tsx` — per-task token table) | None | **Gap.** No inner surface shows cross-task token totals. Slice 2 decides port (a `kobe cost` page in the settings/new-task window pattern) vs drop. |
| `KOBE_NO_DAEMON=1` (local in-process `Orchestrator`, no daemon) | None — `direct.ts` requires the daemon | **Blocker.** app.tsx is the *only* host of the daemon-less Orchestrator. Slice 4 decides the flag's fate before the shell can go. |
| Monitor-only chrome (quit confirm, `usePaneSizes`, `useThemePersistence`, `SyncProvider`, `CommandPaletteProvider` wiring, `ClaudeLauncher` + `launchTaskTmux` in `fullscreen.tsx`) | n/a | Dies with the shell. Audit each module's other consumers at deletion time (`ClaudeLauncher` is app.tsx-only today). |

## Slices to deletion

Ordered; each is one commit/PR, behavior-reviewed on its own.

1. **DONE (this commit) — selection state to the daemon; monitor polling
   hygiene; this doc.** Selection now boots from
   `activeTaskSignal() ?? kv` and only `enterTask` writes the kv key
   (mirroring `direct.ts`); highlight moves no longer persist. The kv path
   could NOT be fully removed: the daemon's `active-task` channel is
   in-memory and lost on idle-stop, and `KOBE_NO_DAEMON` has no persistence —
   so it stays as the documented boot-fallback. LivePreview/CostDashboard
   got in-flight dedupe (the keyed `background-poll` util doesn't fit their
   stateful / whole-list refreshes — rationale inline in each file).
   Scope: S.
2. **Cost dashboard exit.** Decide: port the token table to a tmux-native
   full-window page (`kobe cost`, same host pattern as `kobe settings` /
   `kobe new-task`, opened from the Tasks pane) or drop it and record the
   drop here. `monitor/cost.ts` (the summarizer) is engine-data plumbing and
   survives either way. Scope: S to drop, M to port.
3. **Live preview exit.** Default: drop — session switching inside tmux
   replaces "preview the selected task", and the Tasks pane already carries
   status badges. If at-a-glance multi-task screens prove missed, the port
   target is a Tasks-pane peek or a tmux window, not a revived monitor.
   Record the decision here. Scope: S to drop.
4. **`KOBE_NO_DAEMON` decision.** Either retire the flag (the daemon is the
   product; `kobe doctor`/`reset` cover its failure modes) or rehost the
   local Orchestrator somewhere that isn't app.tsx. Retiring also deletes
   the `Orchestrator`-vs-`RemoteOrchestrator` union handling in `startApp`.
   Needs Jackson's call — it's a supported escape hatch today. Scope: S if
   retired.
5. **Delete the shell.** Remove `app.tsx`, `panes/monitor/`, the
   `KOBE_OUTER_MONITOR` branch in `index.tsx`, and any chrome module whose
   only consumer was the shell (audit: `ClaudeLauncher`/`launchTaskTmux` in
   `fullscreen.tsx`, `SyncProvider`, `CommandPaletteProvider`,
   `usePaneSizes`, `useThemePersistence`). `Sidebar`, `lib/task-actions`,
   and the sidebar lib modules stay — the Tasks pane owns them now. Scope: M
   (mostly deletions + consumer audit).

Slices 2–4 are unordered relative to each other; all three must land before
slice 5. Per the repo's deletion rule, every removal in slices 2–5 requires
explicit user sign-off in that PR's conversation.
