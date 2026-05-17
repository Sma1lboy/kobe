/**
 * Shared content-state type for the preview pane.
 *
 * The main `Preview` component pushes one of these into a Solid signal
 * after each (path, mode) change; the sub-bodies in `./body/` each read
 * it and render their slice. Splitting the type out of `Preview.tsx`
 * is what lets the bodies live in their own files without a circular
 * import back to the component shell.
 *
 *   - `loading` — placeholder while the async fetch is in flight.
 *   - `empty`   — no active tab yet.
 *   - `error`   — fetch failed or the file kind was rejected; `message`
 *                 carries the user-facing summary. Strings starting with
 *                 `(` are treated as informational hints (not red).
 *   - `lines`   — File or Diff mode; `lines` is a flat string array,
 *                 `mode` selects between `FileLine` and `DiffLine`
 *                 rendering inside `LinesBody`.
 *   - `media`   — opaque-binary card (PDF / video / audio / archive)
 *                 OR an inline-rendered image (`decoded` / `animation`).
 *                 See `MediaContent` for field semantics.
 *   - `xml`     — token stream for syntax-highlighted SVG / XML.
 */

import type { ChafaGrid } from "./chafa-render"
import type { ImageDims, MediaKind } from "./media"
import type { PreviewMode } from "./state"
import type { XmlToken } from "./xml-highlight"

/**
 * Snapshot of one media file's metadata, plus an optional rendered
 * character grid (still or animated) for inline-renderable types. We
 * always populate everything we can on the first push so the metadata
 * card has something to show immediately; chafa-rendered grids flow
 * in later via a second `setContent`.
 */
export type MediaContent = {
  readonly relPath: string
  /**
   * Resolved absolute path. Shown on the metadata card for opaque
   * binaries (PDF, video, audio, archives…) so the user can select
   * and copy it into a terminal / `xdg-open` invocation — the
   * "copy-path hint" from the KOB-14 ticket.
   */
  readonly absPath: string
  readonly kind: MediaKind
  readonly size: number
  readonly mtime: Date
  readonly dims?: ImageDims
  /** Static-image preview rendered by chafa into a character grid. */
  readonly grid?: ChafaGrid
  /**
   * Static-image preview rendered as raw sixel bytes. Set when the
   * host terminal supports sixel (see `detectSixelSupport`); takes
   * precedence over `grid` in `MediaBody`.
   */
  readonly sixel?: Buffer
  /**
   * Cell footprint (width × height) the sixel image occupies. We can't
   * derive it from the sixel byte stream cheaply; capture it at decode
   * time so the renderable can claim the right number of cells.
   */
  readonly sixelCells?: { readonly cols: number; readonly rows: number }
  /** Animated frames + frame timing (animated GIFs). */
  readonly animation?: {
    readonly frames: readonly ChafaGrid[]
    readonly frameDelayMs: number
  }
}

export type ContentState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "lines"; lines: string[]; mode: PreviewMode }
  | { kind: "media"; media: MediaContent }
  | { kind: "xml"; rows: XmlToken[][] }
