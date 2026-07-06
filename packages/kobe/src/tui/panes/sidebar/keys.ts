import type { Accessor } from "solid-js"
import { bindByIds } from "../../context/keybindings"
import { useBindings } from "../../lib/keymap"
import { createSidebarController } from "./controller"

export type SidebarBindingsOpts = {
  focused: Accessor<boolean>
  cursorIndex: Accessor<number>
  setCursorIndex: (next: number) => void
  flatTaskIds: Accessor<readonly string[]>
  onSelect: (id: string) => void
  onDeleteRequest?: (taskId: string) => void
  onArchiveRequest?: (taskId: string) => void
  onLocalMergeRequest?: (taskId: string) => void
  moveMode?: Accessor<boolean>
  onMoveRequest?: (taskId: string, delta: -1 | 1) => void
  onMoveModeExit?: () => void
  onRenameRequest?: (taskId: string) => void
  onPinRequest?: (taskId: string) => void
  onPreviewToggleRequest?: (taskId: string) => void
  onViewSwitch?: (delta: -1 | 1) => void
  onSortModeToggle?: () => void
  onProjectFilterToggle?: () => void
  searchMode?: Accessor<boolean>
  onSearchEnter?: () => void
  onSearchExit?: (select: boolean) => void
}

export function useSidebarBindings(opts: SidebarBindingsOpts): void {
  const ctrl = createSidebarController({
    getCursor: () => opts.cursorIndex(),
    setCursor: (n) => opts.setCursorIndex(n),
    getFlatIds: () => opts.flatTaskIds(),
    onSelect: (id) => opts.onSelect(id),
  })

  const cursorTaskId = (): string | undefined => {
    const ids = opts.flatTaskIds()
    const idx = opts.cursorIndex()
    if (idx < 0 || idx >= ids.length) return undefined
    return ids[idx]
  }

  const searchModeAccessor = (): boolean => opts.searchMode?.() ?? false
  const moveModeAccessor = (): boolean => opts.moveMode?.() ?? false

  useBindings(() => ({
    enabled: opts.focused() && !searchModeAccessor(),
    bindings: bindByIds({
      "sidebar.nav": (_evt, slot) => {
        const down = (slot ?? 0) % 2 === 0
        if (moveModeAccessor()) {
          const id = cursorTaskId()
          if (id === undefined) return
          opts.onMoveRequest?.(id, down ? 1 : -1)
          return
        }
        if (down) ctrl.moveDown()
        else ctrl.moveUp()
      },
      "sidebar.select": () => {
        if (moveModeAccessor()) {
          opts.onMoveModeExit?.()
          return
        }
        ctrl.selectCurrent()
      },
      "sidebar.goto": (evt) => {
        if (moveModeAccessor()) return
        if (evt.shift) ctrl.pressShiftG()
        else ctrl.pressG()
      },
      "sidebar.delete": () => {
        if (moveModeAccessor()) return
        const id = cursorTaskId()
        if (id !== undefined) opts.onDeleteRequest?.(id)
      },
      "sidebar.archive": () => {
        if (moveModeAccessor()) return
        const id = cursorTaskId()
        if (id !== undefined) opts.onArchiveRequest?.(id)
      },
      "sidebar.localMerge": (evt) => {
        if (!evt.shift) return
        const id = cursorTaskId()
        if (id !== undefined) opts.onLocalMergeRequest?.(id)
      },
      "sidebar.rename": () => {
        if (moveModeAccessor()) return
        const id = cursorTaskId()
        if (id !== undefined) opts.onRenameRequest?.(id)
      },
      "sidebar.pin": (evt) => {
        if (moveModeAccessor()) return
        if (!evt.shift) return
        const id = cursorTaskId()
        if (id !== undefined) opts.onPinRequest?.(id)
      },
      "sidebar.previewToggle": () => {
        if (moveModeAccessor()) return
        const id = cursorTaskId()
        if (id !== undefined) opts.onPreviewToggleRequest?.(id)
      },
      "sidebar.search.enter": () => {
        if (moveModeAccessor()) return
        opts.onSearchEnter?.()
      },
      "sidebar.sort": () => {
        if (moveModeAccessor()) return
        opts.onSortModeToggle?.()
      },
      "sidebar.projectFilter": () => {
        if (moveModeAccessor()) return
        opts.onProjectFilterToggle?.()
      },
    }),
  }))

  useBindings(() => ({
    enabled: opts.focused() && moveModeAccessor(),
    bindings: [{ key: "escape", cmd: () => opts.onMoveModeExit?.() }],
  }))

  useBindings(() => ({
    enabled: opts.focused(),
    bindings: bindByIds({
      "sidebar.view": (_evt, slot) => {
        opts.onViewSwitch?.((slot ?? 0) % 2 === 0 ? -1 : 1)
      },
    }),
  }))

  useBindings(() => ({
    enabled: opts.focused() && searchModeAccessor(),
    bindings: bindByIds({
      "sidebar.search.nav": (_evt, slot) => {
        if ((slot ?? 0) % 2 === 0) ctrl.moveDown()
        else ctrl.moveUp()
      },
      "sidebar.search.submit": () => {
        ctrl.selectCurrent()
        opts.onSearchExit?.(true)
      },
      "sidebar.search.cancel": () => opts.onSearchExit?.(false),
    }),
  }))
}

export {
  GG_CHORD_TIMEOUT_MS,
  createSidebarController,
  type SidebarController,
  type SidebarControllerOpts,
} from "./controller"
