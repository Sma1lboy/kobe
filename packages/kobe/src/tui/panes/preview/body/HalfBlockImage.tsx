/**
 * Render a {@link DecodedImage} as a stack of half-block character rows.
 * Each TUI row pairs two pixel rows: `fg` paints the upper half, `bg`
 * paints the lower half. We rebuild the cell grid once via
 * `createMemo` so re-renders that don't change the source bytes don't
 * walk the pixel array again.
 *
 * Adjacent cells with identical (fg, bg) pairs are merged into runs
 * keyed by `"rrggbb_rrggbb"`. For real photographic content this is
 * mostly a no-op (every cell differs); for screenshots / UI captures
 * with flat fills it cuts the span count substantially.
 */

import { RGBA } from "@opentui/core"
import { For, createMemo } from "solid-js"
import type { DecodedImage } from "../image-render"

/** Half-block character (U+2580): fg paints the upper half, bg the lower. */
const HALF_BLOCK_UPPER = "▀"

export function HalfBlockImage(props: { decoded: DecodedImage }) {
  type Run = { text: string; fg: RGBA; bg: RGBA }
  const rows = createMemo<Run[][]>(() => {
    const d = props.decoded
    const out: Run[][] = []
    for (let y = 0; y < d.pixelRows; y += 2) {
      const row: Run[] = []
      let cur: Run | null = null
      let curKey = ""
      for (let x = 0; x < d.cols; x++) {
        const topBase = (y * d.cols + x) * 3
        const botBase = ((y + 1) * d.cols + x) * 3
        const tr = d.rgb[topBase]
        const tg = d.rgb[topBase + 1]
        const tb = d.rgb[topBase + 2]
        const br = d.rgb[botBase]
        const bg = d.rgb[botBase + 1]
        const bb = d.rgb[botBase + 2]
        const key = `${tr},${tg},${tb}_${br},${bg},${bb}`
        if (cur && key === curKey) {
          cur.text += HALF_BLOCK_UPPER
          continue
        }
        cur = {
          text: HALF_BLOCK_UPPER,
          fg: RGBA.fromInts(tr, tg, tb, 255),
          bg: RGBA.fromInts(br, bg, bb, 255),
        }
        curKey = key
        row.push(cur)
      }
      out.push(row)
    }
    return out
  })
  return (
    <For each={rows()}>
      {(row) => (
        <text wrapMode="none">
          <For each={row}>{(run) => <span style={{ fg: run.fg, bg: run.bg }}>{run.text}</span>}</For>
        </text>
      )}
    </For>
  )
}
