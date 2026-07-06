import { useRef } from "react"
import { createSidebarController } from "../../../tui/panes/sidebar/controller"
import { bindByIds } from "../../context/keybindings"
import { useBindings } from "../../lib/keymap"

export type SidebarBindingsOpts = {
  focused: boolean
  getCursorIndex: () => number
  setCursorIndex: (next: number) => void
  flatTaskIds: readonly string[]
  onSelect: (id: string) => void
  onDeleteRequest?: (taskId: string) => void
  onArchiveRequest?: (taskId: string) => void
  onLocalMergeRequest?: (taskId: string) => void
  moveMode?: boolean
  onMoveRequest?: (taskId: string, delta: -1 | 1) => void
  onMoveModeExit?: () => void
  onRenameRequest?: (taskId: string) => void
  onPinRequest?: (taskId: string) => void
  onPreviewToggleRequest?: (taskId: string) => void
  onViewSwitch?: (delta: -1 | 1) => void
  onSortModeToggle?: () => void
  onProjectFilterToggle?: () => void
  searchMode?: boolean
  onSearchEnter?: () => void
  onSearchExit?: (select: boolean) => void
}

export function useSidebarBindings(opts: SidebarBindingsOpts): void {
  const optsRef = useRef(opts)
  optsRef.current = opts

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

  const cursorTaskId = (): string | undefined => {
    const ids = optsRef.current.flatTaskIds
    const idx = optsRef.current.getCursorIndex()
    if (idx < 0 || idx >= ids.length) return undefined
    return ids[idx]
  }

  const searchModeOn = (): boolean => optsRef.current.searchMode ?? false
  const moveModeOn = (): boolean => optsRef.current.moveMode ?? false

  useBindings(() => ({
    enabled: optsRef.current.focused && !searchModeOn(),
    bindings: bindByIds({
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

  useBindings(() => ({
    enabled: optsRef.current.focused,
    bindings: bindByIds({
      "sidebar.view": (_evt, slot) => {
        optsRef.current.onViewSwitch?.((slot ?? 0) % 2 === 0 ? -1 : 1)
      },
    }),
  }))

  useBindings(() => ({
    enabled: optsRef.current.focused && searchModeOn(),
    bindings: bindByIds({
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
