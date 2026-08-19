/**
 * React face of `global-mouse-down.ts`: run `handler` on every mouse press
 * that reaches the renderer root, while `enabled`.
 *
 * Why the root and not a full-screen backdrop box: an overlay is an absolute
 * child of the pane that owns it (the sidebar's menu is clipped to the rail),
 * so a backdrop could only cover that pane — a press in the workspace would
 * still leave the popup hanging. The root sees the whole screen.
 */

import { useRenderer } from "@opentui/react"
import { useEffect } from "react"
import { type MouseDownHost, subscribeGlobalMouseDown } from "./global-mouse-down"
import { useLatest } from "./use-latest"

export function useGlobalMouseDown(enabled: boolean, handler: () => void): void {
  const renderer = useRenderer()
  const latest = useLatest(handler)
  useEffect(() => {
    const root = (renderer as { root?: MouseDownHost } | null | undefined)?.root
    if (!enabled || !root) return
    return subscribeGlobalMouseDown(root, () => latest.current())
  }, [enabled, renderer])
}
