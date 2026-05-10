/**
 * ResizableEdge — a 1-cell wide / tall draggable separator between panes.
 *
 * Rendered as a single column (`vertical`) or row (`horizontal`) drawing
 * the `┃` / `━` glyph from {@link SplitBorder} / {@link HSplitBorder}.
 * Hover, drag, and adjacent-pane-focused states each pick a different
 * color so the affordance is discoverable without a tutorial:
 *
 *   - dragging  → `theme.accent`         (active resize feedback)
 *   - hovering  → `theme.borderActive`   (cursor over the edge)
 *   - focused   → `theme.success`        (adjacent pane has focus)
 *   - idle      → `theme.border`
 *
 * The component owns drag state and converts opentui MouseEvents into
 * a controlled `size` value via the caller's `setSize`. On `mouseDown`
 * it captures both the cursor coord and the current size; subsequent
 * `mouseDrag` events emit `setSize(start + delta)` clamped via
 * `props.clamp`. Delta-from-start (rather than absolute coord math)
 * keeps callers layout-agnostic — the edge can be at any `x`/`y` on
 * screen and the math still works.
 */

import type { MouseEvent } from "@opentui/core"
import { type Accessor, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { HSplitBorder, SplitBorder } from "./border"

export type ResizableEdgeProps = {
  /**
   * `vertical` = the edge is a 1-cell-wide column (e.g. between
   * sidebar and workspace); drag along x resizes the pane to its left.
   * `horizontal` = a 1-row-tall divider (e.g. between files and
   * terminal); drag along y resizes the pane above it.
   */
  orientation: "vertical" | "horizontal"
  /** Current size of the resized pane (width or height in cells). */
  size: Accessor<number>
  /** Setter for the resized pane's size. The component clamps before calling. */
  setSize: (next: number) => void
  /** Optional clamp — typically enforces a min and a screen-aware max. */
  clamp?: (next: number) => number
  /**
   * Optional accessor for "the adjacent pane is focused." When true and
   * the edge is idle (not hovered, not dragging), the edge picks up
   * `theme.success` so the focus indicator the old `border={["right"]}`
   * gave us survives the refactor.
   */
  focused?: Accessor<boolean>
}

export function ResizableEdge(props: ResizableEdgeProps) {
  const { theme } = useTheme()
  const [hovering, setHovering] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)

  // Capture-on-mousedown refs. Plain `let` is fine here: each Shell
  // instance gets its own component scope, and these never need to be
  // reactive — they're written once per drag and read on every drag
  // event of that same gesture.
  let startCoord = 0
  let startSize = 0

  const isVertical = () => props.orientation === "vertical"

  // Color priority: dragging > hovering > focused > idle. Dragging
  // overrides hover so the feedback stays unbroken when the cursor
  // outraces opentui's mouse-out delivery.
  const color = () => {
    if (dragging()) return theme.accent
    if (hovering()) return theme.borderActive
    if (props.focused?.()) return theme.success
    return theme.border
  }

  return (
    // biome-ignore lint/a11y/useKeyWithMouseEvents: opentui terminal box; no DOM focus model and resize edges are mouse-only by nature.
    <box
      flexShrink={0}
      width={isVertical() ? 1 : undefined}
      height={isVertical() ? undefined : 1}
      border={isVertical() ? ["left"] : ["top"]}
      customBorderChars={isVertical() ? SplitBorder.customBorderChars : HSplitBorder.customBorderChars}
      borderColor={color()}
      onMouseOver={() => setHovering(true)}
      onMouseOut={() => setHovering(false)}
      onMouseDown={(e: MouseEvent) => {
        setDragging(true)
        startCoord = isVertical() ? e.x : e.y
        startSize = props.size()
      }}
      onMouseDrag={(e: MouseEvent) => {
        if (!dragging()) return
        const cur = isVertical() ? e.x : e.y
        const next = startSize + (cur - startCoord)
        props.setSize(props.clamp ? props.clamp(next) : next)
      }}
      onMouseDragEnd={() => {
        if (dragging()) setDragging(false)
      }}
      onMouseUp={() => {
        if (dragging()) setDragging(false)
      }}
    />
  )
}
