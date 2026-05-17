/**
 * Custom opentui renderable that paints a sixel-encoded image straight
 * to stdout, bypassing opentui's character-cell buffer.
 *
 * The challenge: opentui owns the screen. Its frame-flush diff would
 * normally clobber any raw escape sequence we wrote — the next
 * `lib.render` call writes character cells over the sixel pixels.
 *
 * Trick this works on:
 *   1. `renderSelf` fills the renderable's cell area with a constant
 *      black background (`setCell(' ', BLACK, BLACK)`). Constant means
 *      "same cell content every frame" — opentui's diff sees no change
 *      after the first paint and emits no ANSI for this region.
 *   2. `renderSelf` schedules a `process.nextTick` callback that writes
 *      the sixel bytes. The next-tick queue drains AFTER the current
 *      synchronous render block completes, which means after `lib.render`
 *      has flushed character cells to the terminal. So the sixel lands
 *      *on top of* the just-flushed black cells and stays visible until
 *      another renderable changes those cells.
 *   3. We only re-emit when something material changed: screen position,
 *      cell footprint, or the sixel byte buffer. The renderable is not
 *      `live`, so a static image renders the sixel exactly once after
 *      mount and lets opentui's diff do nothing for the lifetime.
 *
 * Caveats:
 *   - If another renderable later overlaps our region (modal, tooltip,
 *     scroll content), its setCell calls change our buffer cells, opentui
 *     emits ANSI for those changes, and the sixel is partially erased.
 *     The fix would be a force-redraw event on layout changes — we leave
 *     that to a follow-up since the typical preview pane is stable.
 *   - Some terminals (older Konsole, mintty) advance the cursor by the
 *     sixel pixel height in *character cells*, others don't. We write a
 *     cursor-save / cursor-restore wrapper to neutralise the difference.
 *
 * Registration: `extend({ sixel_image: SixelImageRenderable })` is
 * called eagerly at module load, mirroring the chafa-symbols path.
 */

import { type OptimizedBuffer, RGBA, type RenderContext, Renderable, type RenderableOptions } from "@opentui/core"
import { extend } from "@opentui/solid"

const BLACK = RGBA.fromInts(0, 0, 0, 255)

export interface SixelImageOptions extends RenderableOptions<SixelImageRenderable> {
  /** Raw sixel escape sequence — typically the bytes captured from `chafa --format=sixels`. */
  sixel: Buffer
}

type EmissionState = { x: number; y: number; w: number; h: number; sixel: Buffer } | null

export class SixelImageRenderable extends Renderable {
  private _sixel: Buffer
  private _lastEmitted: EmissionState = null

  constructor(ctx: RenderContext, options: SixelImageOptions) {
    super(ctx, options)
    this._sixel = options.sixel
  }

  set sixel(value: Buffer) {
    if (this._sixel !== value) {
      this._sixel = value
      this._lastEmitted = null
      this.requestRender()
    }
  }
  get sixel(): Buffer {
    return this._sixel
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const x = this._screenX
    const y = this._screenY
    const w = this._widthValue
    const h = this._heightValue
    if (w <= 0 || h <= 0 || this._sixel.length === 0) return

    // Fill our cell footprint with a constant black background. The
    // sameness is load-bearing — opentui's diff-based flush won't emit
    // anything for our region on subsequent frames, leaving the sixel
    // pixels we paint via stdout intact.
    for (let row = 0; row < h; row += 1) {
      for (let col = 0; col < w; col += 1) {
        buffer.setCell(x + col, y + row, " ", BLACK, BLACK, 0)
      }
    }

    // Re-emit only on material change. Skipping repeats keeps stdout
    // traffic low — sixel payloads run 10–100 KB for modest-sized
    // images, and writing one per frame would tank the renderer.
    const last = this._lastEmitted
    if (last && last.x === x && last.y === y && last.w === w && last.h === h && last.sixel === this._sixel) {
      return
    }
    const sixel = this._sixel
    // Cursor positions are 1-indexed. Save/restore brackets the write so
    // opentui's next frame doesn't get confused about where the cursor
    // landed (some terminals advance it by the sixel's pixel height).
    const prefix = `\x1b7\x1b[${y + 1};${x + 1}H`
    const suffix = "\x1b8"
    process.nextTick(() => {
      try {
        process.stdout.write(prefix)
        process.stdout.write(sixel)
        process.stdout.write(suffix)
      } catch {
        // stdout might be closed during shutdown — swallowing keeps
        // the renderer from crashing the process on teardown races.
      }
    })
    this._lastEmitted = { x, y, w, h, sixel }
  }

  /**
   * When the renderable is removed from the tree (tab change, switch to
   * a non-image file), overwrite the previously-painted sixel region
   * with spaces so the host terminal evicts the pixels we wrote outside
   * opentui's framebuffer. Without this, a sixel image lingers visually
   * underneath whatever opentui renders next — the colored remnant the
   * user sees as a "rainbow line" when switching from an image to an
   * MP3 metadata card.
   */
  protected override destroySelf(): void {
    const last = this._lastEmitted
    if (last) {
      // Save cursor + SGR, force default attributes (otherwise spaces
      // inherit whatever bg opentui last wrote — a highlighted tab,
      // a theme tint — and the cleared region reads as a coloured
      // bar instead of true background). One extra row below covers
      // sub-cell pixel overflow when the host font isn't exactly the
      // assumed 22-pixel cell height.
      const blank = " ".repeat(Math.max(1, last.w))
      const chunks: string[] = ["\x1b7\x1b[0m"]
      const rows = last.h + 1
      for (let r = 0; r < rows; r += 1) {
        chunks.push(`\x1b[${last.y + 1 + r};${last.x + 1}H${blank}`)
      }
      chunks.push("\x1b8")
      try {
        process.stdout.write(chunks.join(""))
      } catch {
        // stdout might be closed during shutdown — swallow so we
        // don't crash the renderer on teardown races.
      }
    }
    super.destroySelf()
  }
}

extend({ sixel_image: SixelImageRenderable })

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    sixel_image: typeof SixelImageRenderable
  }
}
