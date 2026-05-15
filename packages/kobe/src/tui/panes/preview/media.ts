/**
 * Media-file detection and header parsing for the preview pane (KOB-14).
 *
 * Pure module — no I/O. Callers feed it relative paths (for kind
 * detection) and pre-read header buffers (for image dimensions); we
 * return classification and parsed metadata. Keeping it pure makes the
 * unit tests trivial (no tmpdir / mock-fs setup) and lets the Preview
 * effect orchestrate the actual fs calls alongside its existing
 * `readFile` plumbing.
 *
 * Extension-first detection mirrors the KOB-14 ticket — we never sniff
 * binary content from this module. Files with unrecognized extensions
 * stay in the `text` lane so the existing NUL-byte heuristic in
 * `Preview.tsx` keeps catching unknown binaries (zip/wasm/etc.).
 */

import path from "node:path"

/** Image formats we know how to extract dimensions from. */
export type ImageFormat = "png" | "jpg" | "gif" | "webp"

/**
 * Classification produced from a relative path's extension.
 *
 *   - `image`  → known raster format; preview pane shows a media card
 *                and (if `dims` parses) the pixel dimensions.
 *   - `svg`    → XML text; renders through the regular text pipeline.
 *                Returning a discrete kind lets the caller skip the
 *                NUL-byte sniff (SVGs are pure ASCII/UTF-8 but the sniff
 *                is harmless either way; this just documents intent).
 *   - `binary` → known opaque format (pdf / video / audio / archive).
 *                The `label` is the human-readable description shown
 *                on the media card (e.g. "PDF document").
 *   - `text`   → unknown extension. Caller falls through to the existing
 *                text path; the NUL-byte sniff catches surprise binaries.
 */
export type MediaKind =
  | { readonly kind: "image"; readonly format: ImageFormat }
  | { readonly kind: "svg" }
  | { readonly kind: "binary"; readonly label: string }
  | { readonly kind: "text" }

/** Parsed pixel dimensions from an image file header. */
export type ImageDims = { readonly width: number; readonly height: number }

const IMAGE_EXT: Readonly<Record<string, ImageFormat>> = {
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
}

/**
 * Known opaque-binary extensions and their human labels. Keep this
 * conservative — listing an extension here commits us to rendering a
 * metadata card for it instead of dumping bytes. Anything genuinely
 * unknown should stay in the `text` lane so the NUL-byte sniff decides.
 */
const BINARY_EXT_LABELS: Readonly<Record<string, string>> = {
  pdf: "PDF document",
  // Video
  mp4: "MP4 video",
  mov: "QuickTime video",
  webm: "WebM video",
  mkv: "Matroska video",
  avi: "AVI video",
  // Audio
  mp3: "MP3 audio",
  wav: "WAV audio",
  flac: "FLAC audio",
  ogg: "Ogg audio",
  m4a: "M4A audio",
  // Archives
  zip: "ZIP archive",
  tar: "tarball",
  gz: "gzip archive",
  tgz: "gzip archive",
  bz2: "bzip2 archive",
  xz: "xz archive",
  "7z": "7-Zip archive",
  rar: "RAR archive",
  // Other common opaque formats
  wasm: "WebAssembly module",
  woff: "WOFF font",
  woff2: "WOFF2 font",
  ttf: "TrueType font",
  otf: "OpenType font",
  ico: "icon",
  bmp: "BMP image",
  tiff: "TIFF image",
  tif: "TIFF image",
  heic: "HEIC image",
  avif: "AVIF image",
}

/**
 * Classify a relative path by extension. Case-insensitive; ignores any
 * leading directory component. A path without an extension always falls
 * into the `text` lane — README / Makefile / Dockerfile / etc. are all
 * legitimate text content.
 */
export function detectMediaKind(relPath: string): MediaKind {
  const ext = path.extname(relPath).slice(1).toLowerCase()
  if (!ext) return { kind: "text" }
  if (ext === "svg") return { kind: "svg" }
  const fmt = IMAGE_EXT[ext]
  if (fmt) return { kind: "image", format: fmt }
  const label = BINARY_EXT_LABELS[ext]
  if (label) return { kind: "binary", label }
  return { kind: "text" }
}

/* --------------------------------------------------------------------- */
/*  Image header parsers                                                  */
/*                                                                        */
/*  Each parser reads only the first few bytes of the header and returns  */
/*  pixel dimensions, or null if the buffer doesn't look like the claimed */
/*  format. They never throw. Callers can pass a short prefix buffer      */
/*  (256 B is plenty for PNG / GIF / WEBP; JPEGs may need more if leading */
/*  APP1/EXIF segments are large).                                        */
/* --------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * PNG: 8-byte signature followed by an IHDR chunk. The IHDR chunk's
 * first 8 bytes after the chunk header are width (4B, big-endian) and
 * height (4B, big-endian). We don't validate the chunk type bytes —
 * the signature match is enough to call it.
 */
export function parsePng(buf: Buffer): ImageDims | null {
  if (buf.length < 24) return null
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/**
 * GIF (87a or 89a): 6-byte magic followed by Logical Screen Descriptor
 * with width (2B, little-endian) then height (2B, little-endian).
 */
export function parseGif(buf: Buffer): ImageDims | null {
  if (buf.length < 10) return null
  const sig = buf.subarray(0, 6).toString("ascii")
  if (sig !== "GIF87a" && sig !== "GIF89a") return null
  const width = buf.readUInt16LE(6)
  const height = buf.readUInt16LE(8)
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/**
 * JPEG: starts with 0xFF 0xD8 (SOI). Then a sequence of marker segments;
 * each non-standalone segment is `FF xx LL LL <payload>` where `LL LL`
 * is the segment length (big-endian, includes the length bytes
 * themselves). We scan until we find a Start-of-Frame marker (SOFn,
 * 0xC0..0xCF excluding DHT 0xC4, JPG-ext 0xC8, and DAC 0xCC). The SOF
 * payload is: precision(1B) height(2B BE) width(2B BE) ...
 *
 * Standalone markers (no length) are RST0..RST7 (0xD0..0xD7), SOI/EOI
 * (0xD8/0xD9), and TEM (0x01). We skip those.
 *
 * The buffer length cap is the caller's problem — if the SOF doesn't
 * appear before the buffer ends we return null and the media card
 * just omits dimensions. JPEGs with multi-KB APP1/EXIF blobs may need
 * a larger prefix than 256 B; 32 KB is comfortable.
 */
export function parseJpeg(buf: Buffer): ImageDims | null {
  if (buf.length < 4) return null
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let pos = 2
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null
    let marker = buf[pos + 1]
    // 0xFF padding: skip extra 0xFF bytes before the actual marker.
    while (marker === 0xff && pos + 2 < buf.length) {
      pos += 1
      marker = buf[pos + 1]
    }
    pos += 2
    // Standalone markers with no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue
    if (pos + 2 > buf.length) return null
    const segLen = buf.readUInt16BE(pos)
    if (segLen < 2) return null
    // Start-of-Frame: SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (pos + 7 > buf.length) return null
      const height = buf.readUInt16BE(pos + 3)
      const width = buf.readUInt16BE(pos + 5)
      if (width <= 0 || height <= 0) return null
      return { width, height }
    }
    pos += segLen
  }
  return null
}

/**
 * WEBP: `RIFF <size:4 LE> WEBP <chunkType:4>`. The chunk type tells us
 * which sub-format we have:
 *   - `VP8 ` (lossy) — width/height at offsets 26/28 (each 2B LE, low
 *     14 bits valid).
 *   - `VP8L` (lossless) — at offset 21, the 5-byte payload starts with
 *     signature 0x2F, then a 28-bit packed (width-1 : 14)(height-1 : 14).
 *   - `VP8X` (extended) — width-1 at offset 24 (3B LE), height-1 at
 *     offset 27 (3B LE).
 */
export function parseWebp(buf: Buffer): ImageDims | null {
  if (buf.length < 30) return null
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") return null
  if (buf.subarray(8, 12).toString("ascii") !== "WEBP") return null
  const chunk = buf.subarray(12, 16).toString("ascii")
  if (chunk === "VP8 ") {
    const w = buf.readUInt16LE(26) & 0x3fff
    const h = buf.readUInt16LE(28) & 0x3fff
    if (w <= 0 || h <= 0) return null
    return { width: w, height: h }
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null
    const b0 = buf[21]
    const b1 = buf[22]
    const b2 = buf[23]
    const b3 = buf[24]
    const w = 1 + (((b1 & 0x3f) << 8) | b0)
    const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    if (w <= 0 || h <= 0) return null
    return { width: w, height: h }
  }
  if (chunk === "VP8X") {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
    if (w <= 0 || h <= 0) return null
    return { width: w, height: h }
  }
  return null
}

/** Dispatch on the detected format. Returns null when the header doesn't parse. */
export function parseImageHeader(buf: Buffer, fmt: ImageFormat): ImageDims | null {
  switch (fmt) {
    case "png":
      return parsePng(buf)
    case "gif":
      return parseGif(buf)
    case "jpg":
      return parseJpeg(buf)
    case "webp":
      return parseWebp(buf)
  }
}

/* --------------------------------------------------------------------- */
/*  Formatters                                                            */
/* --------------------------------------------------------------------- */

/**
 * Format a byte count for display on the media card. Uses the
 * IEC-binary scale (KiB / MiB) because the alternative — SI decimal —
 * would disagree with `ls -lh` output users compare against. Cap at
 * three significant figures so "1023 KiB" reads as "1023 KiB" but
 * "1024 KiB" rolls over to "1.00 MiB".
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "? B"
  if (n < 1024) return `${n} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`
}
