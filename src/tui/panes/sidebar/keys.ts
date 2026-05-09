/**
 * Sidebar key bindings — Solid hook layer.
 *
 * j/k (and down/up) navigate between *navigable* tasks. Repo-group
 * headers are skipped — the cursor moves over a `flatTaskIds` array
 * the parent computes from {@link groupByRepo}+{@link buildRows}.
 * `enter` selects the task at the current cursor index. `g g` (chord)
 * jumps to the top, `G` jumps to the bottom — vim conventions, matching
 * opencode's lifted shell.
 *
 * The bindings are gated on a `focused` accessor: kobe's focus model is
 * still owned by the parent (Stream E will manage focus globally in Wave
 * 3+), so the sidebar publishes `enabled = focused()` and trusts the
 * parent. Default `focused = () => true` is provided by the consumer
 * component (`Sidebar.tsx`); the hook itself takes whatever it's given.
 *
 * Architecture: the navigation/chord state machine lives in
 * `controller.ts` (no Solid, no opentui) so unit tests can run under
 * Node. This file only owns the Solid hook + key→method wiring; the
 * `useBindings` import here is the only thing that drags @opentui/solid
 * into this module's import graph.
 *
 * `g g` chord rationale: opentui's keymap layer
 * (`src/tui/lib/keymap.tsx`) has no multi-key chord support. Adding it
 * was out of scope for Stream F (would touch shared infra). When the
 * project grows more chords (`d d`, `c c`, etc.), promote the
 * controller's chord machinery into the keymap layer.
 *
 * No `Esc` binding here: the parent / dialog stack owns escape (the
 * `useBindings` precedence model means a dialog's escape always fires
 * before ours, so we never accidentally swallow it). When the sidebar is
 * the only focusable pane and no dialog is open, escape is a no-op.
 */

import type { Accessor } from "solid-js"
import { useBindings } from "../../lib/keymap"
import { createSidebarController } from "./controller"

/**
 * Arguments for {@link useSidebarBindings}. `cursorIndex`,
 * `setCursorIndex`, and `flatTaskIds` come from the Sidebar's local Solid
 * signals; the component owns the cursor state and we just push it.
 */
export type SidebarBindingsOpts = {
  /** Whether the sidebar should respond to keys at all. */
  focused: Accessor<boolean>
  /** Current cursor index into the flat task id list. -1 if no tasks. */
  cursorIndex: Accessor<number>
  /** Setter for the cursor index. The hook clamps to valid range. */
  setCursorIndex: (next: number) => void
  /** Live flat list of navigable task ids, in display order. */
  flatTaskIds: Accessor<readonly string[]>
  /** Selection callback. Fires on `enter` with the task id under the cursor. */
  onSelect: (id: string) => void
  /**
   * Delete callback. Fires on `d` with the task id under the cursor.
   * The sidebar emits a *request* — the parent (app.tsx) owns the
   * confirm dialog and the orchestrator call. Optional so consumers
   * that don't wire delete (tests, host-mode) just get a no-op. The
   * keymap layer is modifier-aware: the bare `{ key: "d" }` does NOT
   * catch `ctrl+d`.
   */
  onDeleteRequest?: (taskId: string) => void
  /**
   * Archive-toggle callback. Fires on `a` with the task id under the
   * cursor. Wave 4.5 — flips `task.archived` between true and false,
   * which moves the row between the "Working session" and "Archives"
   * views. Optional; like delete, the parent owns the orchestrator
   * call so the sidebar stays a stateless view.
   */
  onArchiveRequest?: (taskId: string) => void
  /**
   * Rename callback. Fires on `r` with the task id under the cursor.
   * The sidebar emits a *request* — the parent (app.tsx) owns the
   * input dialog and the `orchestrator.setTitle` call. Optional, in
   * step with delete/archive, so consumers that don't wire rename
   * (tests, host-mode) get a no-op. Modifier-aware: `ctrl+r` will not
   * match this binding (per `lib/keymap.tsx`).
   *
   * Conflict check: `r` is bound in `panes/filetree/keys.ts` (refresh)
   * and in `component/dialog-diff.tsx` (reload), but those are local
   * to other focused panes / dialogs — sidebar's `r` is free.
   */
  onRenameRequest?: (taskId: string) => void
  /**
   * View-switch callback. Fires on `[` (-1, "previous view") and `]`
   * (+1, "next view"). The parent owns the active-view signal.
   */
  onViewSwitch?: (delta: -1 | 1) => void
}

/**
 * Register the sidebar's pane-local key bindings. Call inside the Solid
 * component that hosts the sidebar — bindings are torn down on unmount
 * via `useBindings`'s onCleanup hook.
 *
 * Internally builds a {@link SidebarController} and wires its methods to
 * the keymap layer.
 */
export function useSidebarBindings(opts: SidebarBindingsOpts): void {
  const ctrl = createSidebarController({
    getCursor: () => opts.cursorIndex(),
    setCursor: (n) => opts.setCursorIndex(n),
    getFlatIds: () => opts.flatTaskIds(),
    onSelect: (id) => opts.onSelect(id),
  })

  useBindings(() => ({
    enabled: opts.focused(),
    bindings: [
      { key: "j", cmd: () => ctrl.moveDown() },
      { key: "down", cmd: () => ctrl.moveDown() },
      { key: "k", cmd: () => ctrl.moveUp() },
      { key: "up", cmd: () => ctrl.moveUp() },
      { key: "return", cmd: () => ctrl.selectCurrent() },
      {
        // Both `g` (arm `g g` chord, complete on second press) and `G`
        // (jump to bottom) come through this binding because the local
        // keymap layer (`src/tui/lib/keymap.tsx`) does not prefix
        // `shift+` for single-letter names — `Shift+G` arrives as
        // `name = "g", shift = true`. We discriminate via `event.shift`
        // inside the handler, which keeps the binding table flat and
        // avoids registering a no-op `shift+g` chord that the matcher
        // would never produce.
        key: "g",
        cmd: (event) => {
          if (event.shift) ctrl.pressShiftG()
          else ctrl.pressG()
        },
      },
      {
        // `d` = delete the task under the cursor. The sidebar only
        // emits the request; the parent owns the confirm dialog and
        // the orchestrator call (so delete UX evolves without the
        // sidebar growing dialog state). The cursor's task id is
        // resolved from `flatTaskIds[cursorIndex]` — the same source
        // of truth `enter` uses, so `d` always targets exactly the
        // visibly-highlighted row. Modifier-aware: `ctrl+d` will not
        // match this binding (per `lib/keymap.tsx`).
        key: "d",
        cmd: () => {
          const ids = opts.flatTaskIds()
          const idx = opts.cursorIndex()
          if (idx < 0 || idx >= ids.length) return
          const id = ids[idx]
          if (id === undefined) return
          opts.onDeleteRequest?.(id)
        },
      },
      {
        // `a` = toggle archived on the cursor task. In the active view
        // it moves the row to Archives; in the archived view it brings
        // it back. Same id-resolution as `d`.
        key: "a",
        cmd: () => {
          const ids = opts.flatTaskIds()
          const idx = opts.cursorIndex()
          if (idx < 0 || idx >= ids.length) return
          const id = ids[idx]
          if (id === undefined) return
          opts.onArchiveRequest?.(id)
        },
      },
      {
        // `r` = rename the task under the cursor. The sidebar emits
        // a request; the parent owns the input dialog and the
        // orchestrator.setTitle call (so the dialog primitive evolves
        // without the sidebar growing input state). Same id-resolution
        // as `d`/`a`. Modifier-aware: `ctrl+r` will not match.
        key: "r",
        cmd: () => {
          const ids = opts.flatTaskIds()
          const idx = opts.cursorIndex()
          if (idx < 0 || idx >= ids.length) return
          const id = ids[idx]
          if (id === undefined) return
          opts.onRenameRequest?.(id)
        },
      },
      // `[` / `]` switch between the Working session and Archives
      // views. Two views today, so both keys do the same thing
      // (toggle), but the +1 / -1 signal is preserved so a future
      // third view (e.g. "Stale" / "Pinned") slots in without a
      // binding rewrite.
      { key: "[", cmd: () => opts.onViewSwitch?.(-1) },
      { key: "]", cmd: () => opts.onViewSwitch?.(1) },
    ],
  }))
}

// Re-export the controller surface so callers that don't need the Solid
// hook can pull both from this module if convenient. Tests should
// import from `./controller` directly to avoid the @opentui/solid
// import that lands transitively through `../../lib/keymap`.
export {
  GG_CHORD_TIMEOUT_MS,
  createSidebarController,
  type SidebarController,
  type SidebarControllerOpts,
} from "./controller"
