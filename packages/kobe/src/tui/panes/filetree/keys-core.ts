import { bindByIds } from "../../context/keybindings"
import type { Binding } from "../../lib/keymap-dispatch"

export type FileTreeTab = "all" | "changes"

export const TAB_ORDER: readonly FileTreeTab[] = ["all", "changes"]

export function tabLabelKey(tab: FileTreeTab): string {
  switch (tab) {
    case "all":
      return "files.tabs.all"
    case "changes":
      return "files.tabs.changes"
  }
}

export type FileTreeController = {
  moveDown: () => void
  moveUp: () => void
  setTab: (tab: FileTreeTab) => void
  currentTab: () => FileTreeTab
  openCurrent: () => void
  mentionCurrent?: () => void
  createPR?: () => void
  openExternal: () => void
  refresh: () => void
  expandOrDescend: () => void
  collapseOrParent: () => void
}

export function fileTreeBindings(opts: FileTreeController): Binding[] {
  return bindByIds({
    "files.nav": (_evt, slot) => {
      if ((slot ?? 0) % 2 === 0) opts.moveDown()
      else opts.moveUp()
    },
    "files.hierarchy": (_evt, slot) => {
      if ((slot ?? 0) % 2 === 0) opts.collapseOrParent()
      else opts.expandOrDescend()
    },
    "files.tab": (_evt, slot) => {
      const cur = opts.currentTab()
      const idx = TAB_ORDER.indexOf(cur)
      if (idx < 0) return
      const delta = (slot ?? 0) % 2 === 0 ? -1 : 1
      const next = TAB_ORDER[(idx + delta + TAB_ORDER.length) % TAB_ORDER.length]
      if (next) opts.setTab(next)
    },
    "files.open": () => opts.openCurrent(),
    "files.mention": () => opts.mentionCurrent?.(),
    "files.createPR": () => opts.createPR?.(),
    "files.openExternal": () => opts.openExternal(),
    "files.refresh": () => opts.refresh(),
  })
}
