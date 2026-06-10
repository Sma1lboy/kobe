# Retiring `app.tsx` — the deprecated outer monitor

> **RETIRED 2026-06-09.** All slices landed; the monitor is gone.
> Jackson's calls (slices 2–4, decided explicitly): **Cost Dashboard —
> dropped, no port** (no `kobe cost` page); **Live Preview — dropped**
> (session switching + Tasks-pane badges replace it); **`KOBE_NO_DAEMON`
> — retired** (the daemon is the product; `kobe doctor` / `kobe reset`
> cover its failure modes; the local in-TUI `Orchestrator` hosting path
> is gone — the `Orchestrator` class itself survives, hosted by the
> daemon). With those decided, slice 5 deleted the shell: `app.tsx`,
> `panes/monitor/`, the `KOBE_OUTER_MONITOR`/`KOBE_NO_DAEMON` branch in
> `index.tsx`, and the chrome modules whose only consumer was the shell.
> `kobe` now launches straight into the task session flow (`direct.ts`).
> This doc is kept as the record of the inventory + decisions.

`packages/kobe/src/tui/app.tsx` *was* the v0.6 outer monitor: an opentui
shell (sidebar + live preview + cost dashboard) that predates the
inner-first direction. The product path is `direct.ts` — straight into the
tmux workspace — and the monitor was reachable only via
`KOBE_OUTER_MONITOR=1` or `KOBE_NO_DAEMON=1` (`src/tui/index.tsx`). This
doc was the map for the deletion PRs: what the monitor still owned, what
already had a tmux-native home, what would genuinely be lost, and the
ordered slices to deletion.

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
2. **DONE (2026-06-09) — Cost dashboard exit: DROPPED, no port.** Jackson's
   call. No `kobe cost` page; cross-task token totals have no TUI surface —
   recorded here as a drop, per the honesty rule. `monitor/cost.ts` (the
   summarizer) survives as engine-data plumbing: the Engine Registry's
   `summarizeCost` field and `engine/claude-code-local/cost.ts` consume it,
   and their tests stay. `monitor/capture-pane.ts` (LivePreview-only) died
   with slice 3.
3. **DONE (2026-06-09) — Live preview exit: DROPPED.** Jackson's call, per
   the default: session switching inside tmux replaces "preview the
   selected task", and the Tasks pane carries status badges. If at-a-glance
   multi-task screens prove missed, the port target is a Tasks-pane peek or
   a tmux window, not a revived monitor.
4. **DONE (2026-06-09) — `KOBE_NO_DAEMON`: RETIRED.** Jackson's call. The
   daemon is the product; `kobe doctor`/`kobe reset` cover its failure
   modes. The flag, the local-Orchestrator-in-TUI hosting path, and the
   `Orchestrator`-vs-`RemoteOrchestrator` union handling in `startApp` are
   gone. The `Orchestrator` class itself stays — the daemon hosts it.
5. **DONE (2026-06-09) — shell deleted.** Removed `app.tsx`,
   `panes/monitor/`, and the env-flag branch in `index.tsx` (`kobe` now
   goes straight to `direct.ts`). Chrome modules whose only consumer was
   the shell went with it: `fullscreen.tsx` (`ClaudeLauncher` +
   `launchTaskTmux` + `runFullscreen` — `direct.ts` has its own
   `attachTmux`), `SyncProvider`, `CommandPaletteProvider` (and the
   `palette.open` keymap row), `usePaneSizes`, `useThemePersistence`,
   `status-bar.tsx` (+ the `useCtrlCArmed` Ctrl+C arm-to-quit machinery and
   the `app.copy_or_quit` row it displayed), `top-bar.tsx` +
   `top-bar-helpers.ts`, `pane-header.tsx`, `resizable-edge.tsx` (+ its
   `border.tsx` glyphs, and the never-registered `pane.resize-*` rows),
   `monitor/capture-pane.ts`, the unused `useKobeKeybindings` hook (the
   `KobeKeymap` table, `bindByIds`, and the help dialog stay), and the
   `focus.next`/`focus.prev` rows the hook registered. `Sidebar`,
   `lib/task-actions`, and the sidebar lib modules stay — the Tasks pane
   owns them now. Kept despite looking dead: `context/focus.tsx`
   (FocusProvider is part of `bootPaneHost`'s shared provider nest).

All slices landed; per the repo's deletion rule, every removal in slices
2–5 carried explicit user sign-off in that slice's conversation.
