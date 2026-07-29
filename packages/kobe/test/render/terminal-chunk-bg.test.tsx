/** @jsxImportSource @opentui/react */
/**
 * Regression probe: a terminal chunk's BACKGROUND color must survive to the
 * painted frame. Half-block renderers (carbonyl, the video plugin) draw two
 * pixels per cell as `▀` with fg = top pixel and bg = bottom pixel — if the
 * paint path drops chunk bg, every other scanline shows the theme background
 * instead ("zebra stripes" bug). Mirrors the Terminal pane's exact path:
 * rowsToStyledText → StyledText → TextRenderable.content.
 */

import { StyledText, type TextRenderable } from "@opentui/core"
import { useEffect, useState } from "react"
import { expect, test } from "bun:test"
import { rowsToStyledText } from "../../src/tui/panes/terminal/sgr-to-text-chunk"
import { renderComponent } from "./harness"

function HalfBlockRow() {
  const [el, setEl] = useState<TextRenderable | null>(null)
  useEffect(() => {
    if (el && !el.isDestroyed) {
      el.content = new StyledText(
        rowsToStyledText([
          [{ text: "▀▀▀", fg: [255, 0, 0], bg: [0, 0, 255] }],
          [{ text: "   ", bg: [0, 255, 0] }],
        ]),
      )
    }
  }, [el])
  return <text ref={setEl} />
}

test("chunk fg AND bg reach the painted frame (half-block zebra regression)", async () => {
  const handle = await renderComponent(<HalfBlockRow />, { width: 10, height: 4 })
  try {
    const spans = await handle.spans()
    const flat = JSON.stringify(spans)
    // Span colors serialize as RGBA buffers: {"0":r,"1":g,"2":b,"3":a}.
    expect(flat).toContain("▀")
    expect(flat).toContain('"0":255,"1":0,"2":0,"3":255') // fg red
    expect(flat).toContain('"0":0,"1":0,"2":255,"3":255') // bg blue
    // bg-only spaces are the carbonyl solid-fill case.
    expect(flat).toContain('"0":0,"1":255,"2":0,"3":255') // bg green
  } finally {
    handle.destroy()
  }
})
