/**
 * Sidebar key bindings — React hook layer (issue #15, G3), the
 * `src/tui/panes/sidebar/keys.ts` counterpart. The navigation/chord state
 * machine is the shared framework-free `tui/panes/sidebar/controller.ts`;
 * this file owns only the React hook + key→method wiring through the
 * render-refreshed-ref `useBindings` (tui-react/lib/keymap).
 *
 * Contract parity notes:
 *   - Opts are plain per-render values (the Solid accessors' React shape);
 *     the hook reads them through a ref refreshed every render, so the
 *     per-keypress config always sees the latest render's state.
 *   - The cursor is the one exception: reads go through `getCursorIndex`
 *     because two keypresses can land between renders (React state commits
 *     asynchronously) — the Sidebar backs it with a ref so a fast j·j
 *     doesn't move from a stale index.
 *   - Same three binding blocks (letters+`/`, view switch, search-mode) and
 *     the same slot/evt.shift discrimination as the Solid hook.
 */

import { useRef } from "react"
import { createSidebarController } from "../../../tui/panes/sidebar/controller"
import { bindByIds } from "../../context/keybindings"
import { useBindings } from "../../lib/keymap"
import { useLatest } from "../../lib/use-latest"
import type { SidebarTaskCallbacks } from "./types"

export type SidebarBindingsOpts = SidebarTaskCallbacks & {
  /** Whether the sidebar should respond to keys at all. */
  focused: boolean
  /** Live cursor read — ref-backed by the Sidebar (see header). */
  getCursorIndex: () => number
  /** Setter for the cursor index. The controller clamps to valid range. */
  setCursorIndex: (next: number) => void
  /** Flat list of navigable task ids, in display order (latest render). */
  flatTaskIds: readonly string[]
  /** Selection callback. Fires on `enter` with the task id under the cursor. */
  onSelect: (id: string) => void
  /** `[` (-1) / `]` (+1). Always live, even during search. */
  onViewSwitch?: (delta: -1 | 1) => void
  onProjectFilterToggle?: () => void
  /** While true, single-letter chords are de-registered so typing reaches the search input. */
  searchMode?: boolean
  onSearchEnter?: () => void
  onSearchExit?: (select: boolean) => void
}

/**
 * Register the sidebar's pane-local key bindings for the lifetime of the
 * calling component. Same behavior contract as the Solid hook — see
 * `src/tui/panes/sidebar/keys.ts` for the full per-binding rationale.
 */
export function useSidebarBindings(opts: SidebarBindingsOpts): void {
  const optsRef = useLatest(opts)

  // One controller per mount: it owns the g·g chord timer state. Its
  // callbacks read through optsRef so they never go stale across renders.
  const ctrlRef = useRef<ReturnType<typeof createSidebarController> | null>(null)
  if (ctrlRef.current === null) {
    ctrlRef.current = createSidebarController({
      getCursor: () => optsRef.current.getCursorIndex(),
      setCursor: (n) => optsRef.current.setCursorIndex(n),
      getFlatIds: () => optsRef.current.flatTaskIds,
      onSelect: (id) => optsRef.current.onSelect(id),
    })
  }
  const ctrl = ctrlRef.current

  // Resolve the task id under the cursor for d/a/r — same source of truth
  // as `enter` so the visible-highlight row is always the target.
  const cursorTaskId = (): string | undefined => {
    const ids = optsRef.current.flatTaskIds
    const idx = optsRef.current.getCursorIndex()
    if (idx < 0 || idx >= ids.length) return undefined
    return ids[idx]
  }

  const searchModeOn = (): boolean => optsRef.current.searchMode ?? false
  const moveModeOn = (): boolean => optsRef.current.moveMode ?? false

  // Block A — letter chords + `/` to enter search. Disabled while the user
  // is typing in the search input.
  useBindings(() => ({
    enabled: optsRef.current.focused && !searchModeOn(),
    bindings: bindByIds({
      // Direction-multiplexed: slot layout is alternating [down, up] pairs.
      "sidebar.nav": (_evt, slot) => {
        const down = (slot ?? 0) % 2 === 0
        if (moveModeOn()) {
          const id = cursorTaskId()
          if (id === undefined) return
          optsRef.current.onMoveRequest?.(id, down ? 1 : -1)
          return
        }
        if (down) ctrl.moveDown()
        else ctrl.moveUp()
      },
      "sidebar.select": () => {
        if (moveModeOn()) {
          optsRef.current.onMoveModeExit?.()
          return
        }
        ctrl.selectCurrent()
      },
      // gg chord (top) / Shift+G (bottom); shift is discriminated via evt.
      "sidebar.goto": (evt) => {
        if (moveModeOn()) return
        if (evt.shift) ctrl.pressShiftG()
        else ctrl.pressG()
      },
      "sidebar.delete": () => {
        if (moveModeOn()) return
        const id = cursorTaskId()
        if (id !== undefined) optsRef.current.onDeleteRequest?.(id)
      },
      "sidebar.archive": () => {
        if (moveModeOn()) return
        const id = cursorTaskId()
        if (id !== undefined) optsRef.current.onArchiveRequest?.(id)
      },
      "sidebar.localMerge": (evt) => {
        if (!evt.shift) return
        const id = cursorTaskId()
        if (id !== undefined) optsRef.current.onLocalMergeRequest?.(id)
      },
      "sidebar.rename": () => {
        if (moveModeOn()) return
        const id = cursorTaskId()
        if (id !== undefined) optsRef.current.onRenameRequest?.(id)
      },
      "sidebar.pin": (evt) => {
        if (moveModeOn()) return
        if (!evt.shift) return
        const id = cursorTaskId()
        if (id !== undefined) optsRef.current.onPinRequest?.(id)
      },
      "sidebar.previewToggle": () => {
        if (moveModeOn()) return
        const id = cursorTaskId()
        if (id !== undefined) optsRef.current.onPreviewToggleRequest?.(id)
      },
      "sidebar.search.enter": () => {
        if (moveModeOn()) return
        optsRef.current.onSearchEnter?.()
      },
      "sidebar.sort": () => {
        if (moveModeOn()) return
        optsRef.current.onSortModeToggle?.()
      },
      "sidebar.projectFilter": () => {
        if (moveModeOn()) return
        optsRef.current.onProjectFilterToggle?.()
      },
    }),
  }))

  useBindings(() => ({
    enabled: optsRef.current.focused && moveModeOn(),
    bindings: [{ key: "escape", cmd: () => optsRef.current.onMoveModeExit?.() }],
  }))

  // Block B — view switcher. Always on (even during search).
  useBindings(() => ({
    enabled: optsRef.current.focused,
    bindings: bindByIds({
      // Slot layout: [previous view, next view] pairs (default ["[", "]"]).
      "sidebar.view": (_evt, slot) => {
        optsRef.current.onViewSwitch?.((slot ?? 0) % 2 === 0 ? -1 : 1)
      },
    }),
  }))

  // Block C — search-mode chords, registered only while the input shows.
  useBindings(() => ({
    enabled: optsRef.current.focused && searchModeOn(),
    bindings: bindByIds({
      // j/k intentionally excluded — they must reach the input as text.
      "sidebar.search.nav": (_evt, slot) => {
        if ((slot ?? 0) % 2 === 0) ctrl.moveDown()
        else ctrl.moveUp()
      },
      "sidebar.search.submit": () => {
        ctrl.selectCurrent()
        optsRef.current.onSearchExit?.(true)
      },
      "sidebar.search.cancel": () => optsRef.current.onSearchExit?.(false),
    }),
  }))
}
