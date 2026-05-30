/**
 * Pane sizing (v0.6).
 *
 * Only the sidebar↔workspace splitter remains in v0.6 — the right
 * column (files / preview / terminal) is gone with the chat pane.
 * Step D (KOB-230) will bring back a `monitorWidth` for the live
 * preview rail.
 */

import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createEffect, createSignal } from "solid-js"
import type { KVContext } from "../context/kv"

const MIN_SIDEBAR_WIDTH = 18
const MIN_WORKSPACE_WIDTH = 30
const DEFAULT_SIDEBAR_WIDTH = 32

export type PaneSizes = {
  sidebarWidth: Accessor<number>
  setSidebarWidth: (w: number) => void
  clampSidebar: (w: number) => number
}

export function usePaneSizes(kv: KVContext): PaneSizes {
  const dims = useTerminalDimensions()
  const persistedSidebar = (() => {
    const v = kv.get("paneSidebarWidth")
    return typeof v === "number" && v >= MIN_SIDEBAR_WIDTH ? v : null
  })()
  const [sidebarWidth, setSidebarWidth] = createSignal(persistedSidebar ?? DEFAULT_SIDEBAR_WIDTH)

  createEffect(() => {
    kv.set("paneSidebarWidth", sidebarWidth())
  })

  const clampSidebar = (w: number) => {
    const max = Math.max(MIN_SIDEBAR_WIDTH, dims().width - MIN_WORKSPACE_WIDTH - 1 /* one splitter */)
    return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, w))
  }

  return { sidebarWidth, setSidebarWidth, clampSidebar }
}
