/**
 * Display formatters used by the preview pane's media card.
 *
 * Pure functions over already-classified data; no I/O, no opentui
 * imports. Extracted from `Preview.tsx` so each body file can pull just
 * the helpers it needs without dragging the full component graph in.
 */

import { type ImageFormat, type MediaKind, formatBytes } from "./media"

/**
 * Human label for a {@link MediaKind}. The image branch maps each
 * known raster format to its canonical name; everything else either
 * carries its label inline (video / binary) or has a single fixed
 * description.
 */
export function describeMediaKind(kind: MediaKind): string {
  switch (kind.kind) {
    case "image": {
      const labels: Readonly<Record<ImageFormat, string>> = {
        png: "PNG image",
        jpg: "JPEG image",
        gif: "GIF image",
        webp: "WEBP image",
      }
      return labels[kind.format]
    }
    case "video":
      return kind.label
    case "pdf":
      return "PDF document"
    case "binary":
      return kind.label
    case "svg":
      return "SVG image"
    case "text":
      return "text"
  }
}

/**
 * Compact `YYYY-MM-DD HH:MM` formatter for the mtime line. Local time
 * (matches `ls -l` behaviour); no seconds (too noisy for a preview
 * card), no timezone suffix (the user is already in their own).
 */
export function formatMtime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Re-export so body files can pull all display formatters from one place. */
export { formatBytes }
