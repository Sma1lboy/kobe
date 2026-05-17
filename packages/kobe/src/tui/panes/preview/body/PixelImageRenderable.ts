/**
 * Custom opentui renderable that paints a pre-decoded RGBA pixel buffer
 * into its layout cell via `OptimizedBuffer.drawSuperSampleBuffer`.
 *
 * The Zig backend behind `drawSuperSampleBuffer` picks the densest cell
 * representation the host terminal can render — sixel on Windows
 * Terminal / xterm / mlterm, kitty graphics on kitty, iTerm inline
 * images on iTerm, and supersampled quadrant / half-block fallback
 * elsewhere. That lets the preview pane stay one renderable across all
 * those backends without us writing escape sequences ourselves.
 *
 * The renderable is sized in *cells* (via `width`/`height` layout
 * options) but receives the pixel buffer in *pixels*. We expose
 * `pixelCols` / `pixelRows` so callers can drop in a different image
 * without re-creating the renderable.
 *
 * `extend({ pixel_image: PixelImageRenderable })` is called eagerly at
 * module-load time so importing this file is enough to make the
 * `<pixel_image …>` JSX element available — no separate registration
 * step needed.
 */

import { ptr as bunPtr } from "bun:ffi"
import { type OptimizedBuffer, type RenderContext, Renderable, type RenderableOptions } from "@opentui/core"
import { extend } from "@opentui/solid"

export interface PixelImageOptions extends RenderableOptions<PixelImageRenderable> {
  /** RGBA pixel bytes — exactly `pixelCols * pixelRows * 4` of them. */
  pixels: Uint8Array
  pixelCols: number
  pixelRows: number
}

export class PixelImageRenderable extends Renderable {
  private _pixels: Uint8Array
  private _pixelCols: number
  private _pixelRows: number

  constructor(ctx: RenderContext, options: PixelImageOptions) {
    super(ctx, options)
    this._pixels = options.pixels
    this._pixelCols = options.pixelCols
    this._pixelRows = options.pixelRows
  }

  set pixels(value: Uint8Array) {
    if (this._pixels !== value) {
      this._pixels = value
      this.requestRender()
    }
  }
  get pixels(): Uint8Array {
    return this._pixels
  }

  set pixelCols(value: number) {
    if (this._pixelCols !== value) {
      this._pixelCols = value
      this.requestRender()
    }
  }
  get pixelCols(): number {
    return this._pixelCols
  }

  set pixelRows(value: number) {
    if (this._pixelRows !== value) {
      this._pixelRows = value
      this.requestRender()
    }
  }
  get pixelRows(): number {
    return this._pixelRows
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this._pixels.length === 0 || this._pixelCols <= 0 || this._pixelRows <= 0) return
    const expected = this._pixelCols * this._pixelRows * 4
    if (this._pixels.length !== expected) return
    buffer.drawSuperSampleBuffer(
      this._screenX,
      this._screenY,
      bunPtr(this._pixels),
      this._pixels.byteLength,
      "rgba8unorm",
      this._pixelCols * 4,
    )
  }
}

extend({ pixel_image: PixelImageRenderable })

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    pixel_image: typeof PixelImageRenderable
  }
}
