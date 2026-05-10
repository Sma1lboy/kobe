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
import { bindByIds } from "../../context/keybindings"
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

  // Resolve the task id under the cursor for d/a/r. Same source of
  // truth as `enter` (sidebar.select) so the visible-highlight row is
  // always the target.
  const cursorTaskId = (): string | undefined => {
    const ids = opts.flatTaskIds()
    const idx = opts.cursorIndex()
    if (idx < 0 || idx >= ids.length) return undefined
    return ids[idx]
  }

  useBindings(() => ({
    enabled: opts.focused(),
    bindings: bindByIds({
      // sidebar.nav covers j/k/down/up — handler discriminates direction
      // via evt.name. The matcher delivers e.g. {name: "j"} or {name: "down"}.
      "sidebar.nav": (evt) => {
        if (evt.name === "j" || evt.name === "down") ctrl.moveDown()
        else if (evt.name === "k" || evt.name === "up") ctrl.moveUp()
      },
      "sidebar.select": () => ctrl.selectCurrent(),
      // `g`: gg chord (top) on the second press; shift-G (bottom) on
      // first press. opentui's keymap drops shift on letter keys
      // (lib/keymap.tsx:70), so the chord registered is just "g" and
      // we discriminate via evt.shift inside the handler.
      "sidebar.goto": (evt) => {
        if (evt.shift) ctrl.pressShiftG()
        else ctrl.pressG()
      },
      "sidebar.delete": () => {
        const id = cursorTaskId()
        if (id !== undefined) opts.onDeleteRequest?.(id)
      },
      "sidebar.archive": () => {
        const id = cursorTaskId()
        if (id !== undefined) opts.onArchiveRequest?.(id)
      },
      "sidebar.rename": () => {
        const id = cursorTaskId()
        if (id !== undefined) opts.onRenameRequest?.(id)
      },
      // `[` and `]` both register against sidebar.view; handler routes
      // by chord. `]` = +1 ("next view"), `[` = -1.
      "sidebar.view": (evt) => {
        if (evt.name === "]") opts.onViewSwitch?.(1)
        else opts.onViewSwitch?.(-1)
      },
    }),
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
