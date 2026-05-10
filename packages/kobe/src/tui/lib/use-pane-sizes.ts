/**
 * Pane sizing for the 5-pane Shell — three controlled widths/heights
 * (sidebar, workspace, files) plus the keyboard-resize nudger.
 *
 * Sidebar default 42 (the long-standing "history rail" convention from
 * opencode/agent-deck). Workspace and files are seeded from the
 * pre-resize 2:1 flex ratio so the layout looks the same on first paint
 * and starts diverging only when the user drags. We keep the sizes as
 * plain numbers (not optional) so the layout is always controlled —
 * simpler than juggling a "have they dragged yet" flag, at the cost of
 * not auto-rebalancing on terminal resize (just clamps to fit).
 *
 * Mins: sidebar 20 (status badge + first 8-10 chars of a title still
 * legible); workspace 30 (chat needs room to breathe); right column min
 * is implicit via "max workspace = total - sidebar - 1 splitter - min
 * right". Files min 5 / terminal min 5 (header + ~3 rows of content).
 *
 * The keyboard-resize nudger (ctrl+= / ctrl+-) lives here so the hook
 * owns the full size-control surface. Shell threads `nudge` into
 * `useAppKeymap` deps.
 *
 * Must be invoked inside a Solid component scope — `useTerminalDimensions`
 * reads the renderer, and the persistence effects are part of the
 * surrounding owner's lifecycle.
 */

import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createEffect, createSignal } from "solid-js"
import type { PaneId } from "../context/focus"
import type { KVContext } from "../context/kv"

const MIN_SIDEBAR_WIDTH = 20
const MIN_WORKSPACE_WIDTH = 30
const MIN_RIGHT_COLUMN_WIDTH = 30
const MIN_FILES_HEIGHT = 5
const MIN_TERMINAL_HEIGHT = 5

export type PaneSizes = {
  sidebarWidth: Accessor<number>
  setSidebarWidth: (w: number) => void
  workspaceWidth: Accessor<number>
  setWorkspaceWidth: (w: number) => void
  filesHeight: Accessor<number>
  setFilesHeight: (h: number) => void
  /** Clamps for the three <ResizableEdge /> splitters. */
  clampSidebar: (w: number) => number
  clampWorkspace: (w: number) => number
  clampFiles: (h: number) => number
  /**
   * Keyboard-resize nudger — grow or shrink whichever pane is focused.
   * The terminal pane grows by *shrinking* `filesHeight` (terminal height
   * is the residual under `filesHeight` in the right column).
   */
  nudge: (delta: number, focused: PaneId) => void
}

export function usePaneSizes(kv: KVContext): PaneSizes {
  const dims = useTerminalDimensions()
  // Hydrate the resize-pane sizes from KV when present so a kobe restart
  // lands on the layout the user dragged into last session. Defaults are
  // computed off the live terminal dims when KV has nothing — first
  // launch on a small terminal still gets a sensible starting point.
  // We persist via createEffect below, debounced by the natural drag
  // throttle (mouse-move events update the signal; KV.set is cheap).
  const persistedSidebar = (() => {
    const v = kv.get("paneSidebarWidth")
    return typeof v === "number" && v >= MIN_SIDEBAR_WIDTH ? v : null
  })()
  const persistedWorkspace = (() => {
    const v = kv.get("paneWorkspaceWidth")
    return typeof v === "number" && v >= MIN_WORKSPACE_WIDTH ? v : null
  })()
  const persistedFiles = (() => {
    const v = kv.get("paneFilesHeight")
    return typeof v === "number" && v >= MIN_FILES_HEIGHT ? v : null
  })()
  const initialDims = dims()
  const [sidebarWidth, setSidebarWidth] = createSignal(persistedSidebar ?? 42)
  // Initial workspace / files seeds: computed once from the terminal
  // dims at mount when KV has nothing. These are deliberately not
  // reactive to terminal resizes — the user's last drag wins.
  const [workspaceWidth, setWorkspaceWidth] = createSignal(
    persistedWorkspace ?? Math.max(MIN_WORKSPACE_WIDTH, Math.floor((initialDims.width - 42 - 1) * (2 / 3))),
  )
  const initialRightColumnHeight = Math.max(20, initialDims.height - 2 - 1)
  const [filesHeight, setFilesHeight] = createSignal(
    persistedFiles ?? Math.max(MIN_FILES_HEIGHT, Math.floor(initialRightColumnHeight * (2 / 3))),
  )

  // Persist on every resize. The signals only change during a drag (or
  // a clamp on terminal resize), so this fires per drag-frame at most —
  // KV.set is in-memory until the provider's debounced write hits disk.
  createEffect(() => {
    kv.set("paneSidebarWidth", sidebarWidth())
  })
  createEffect(() => {
    kv.set("paneWorkspaceWidth", workspaceWidth())
  })
  createEffect(() => {
    kv.set("paneFilesHeight", filesHeight())
  })

  const clampSidebar = (w: number) => {
    const max = Math.max(
      MIN_SIDEBAR_WIDTH,
      dims().width - workspaceWidth() - MIN_RIGHT_COLUMN_WIDTH - 2 /* two splitters */,
    )
    return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, w))
  }
  const clampWorkspace = (w: number) => {
    const max = Math.max(
      MIN_WORKSPACE_WIDTH,
      dims().width - sidebarWidth() - MIN_RIGHT_COLUMN_WIDTH - 2 /* two splitters */,
    )
    return Math.min(max, Math.max(MIN_WORKSPACE_WIDTH, w))
  }
  const clampFiles = (h: number) => {
    // Files height max = right column height - terminal min - 1 (splitter).
    // We approximate right column height as `dims.height - topbar - statusbar`.
    const rightColH = Math.max(MIN_FILES_HEIGHT + MIN_TERMINAL_HEIGHT + 1, dims().height - 2)
    const max = Math.max(MIN_FILES_HEIGHT, rightColH - MIN_TERMINAL_HEIGHT - 1)
    return Math.min(max, Math.max(MIN_FILES_HEIGHT, h))
  }

  // Keyboard resize for the focused pane — fallback when mouse drag
  // misfires on the splitter. ctrl+= / ctrl++ grows, ctrl+- / ctrl+_
  // shrinks. The keymap normalizer (lib/keymap.tsx) drops the shift
  // modifier on single-char names since shift+= already produces `+`,
  // so we register both `+` and `=` on the grow side and both `-` and
  // `_` on the shrink side to match whatever shape the terminal sends.
  // Terminal pane grows by SHRINKING filesHeight (its height is the
  // residual under filesHeight in the right column); the rest of the
  // panes grow their own width/height directly.
  const nudge = (delta: number, focused: PaneId): void => {
    switch (focused) {
      case "sidebar":
        setSidebarWidth(clampSidebar(sidebarWidth() + delta))
        return
      case "workspace":
        setWorkspaceWidth(clampWorkspace(workspaceWidth() + delta))
        return
      case "files":
        setFilesHeight(clampFiles(filesHeight() + delta))
        return
      case "terminal":
        // Inverse: growing the terminal = shrinking files above it.
        setFilesHeight(clampFiles(filesHeight() - delta))
        return
    }
  }

  return {
    sidebarWidth,
    setSidebarWidth,
    workspaceWidth,
    setWorkspaceWidth,
    filesHeight,
    setFilesHeight,
    clampSidebar,
    clampWorkspace,
    clampFiles,
    nudge,
  }
}
