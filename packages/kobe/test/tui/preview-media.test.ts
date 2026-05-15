/**
 * Unit tests for preview/media.ts (KOB-14).
 *
 * Covers:
 *   - extension-based kind detection
 *   - image-header parsers (PNG / GIF / JPEG / WEBP-VP8)
 *   - byte-size formatter
 *
 * Fixtures are constructed inline as Buffers — no fs / tmpdir / external
 * binaries — so the suite stays in the fast tier.
 */
import {
  type ImageFormat,
  detectMediaKind,
  formatBytes,
  parseGif,
  parseImageHeader,
  parseJpeg,
  parsePng,
  parseWebp,
} from "@/tui/panes/preview/media"
import { describe, expect, it } from "vitest"

describe("detectMediaKind", () => {
  it("classifies known image extensions", () => {
    expect(detectMediaKind("foo.png")).toEqual({ kind: "image", format: "png" })
    expect(detectMediaKind("foo.PNG")).toEqual({ kind: "image", format: "png" })
    expect(detectMediaKind("foo.jpg")).toEqual({ kind: "image", format: "jpg" })
    expect(detectMediaKind("foo.jpeg")).toEqual({ kind: "image", format: "jpg" })
    expect(detectMediaKind("foo.gif")).toEqual({ kind: "image", format: "gif" })
    expect(detectMediaKind("foo.webp")).toEqual({ kind: "image", format: "webp" })
  })

  it("classifies svg as its own kind so the caller can skip the binary sniff", () => {
    expect(detectMediaKind("logo.svg")).toEqual({ kind: "svg" })
  })

  it("classifies opaque binary formats with a human label", () => {
    expect(detectMediaKind("paper.pdf")).toEqual({ kind: "binary", label: "PDF document" })
    expect(detectMediaKind("clip.mp4")).toEqual({ kind: "binary", label: "MP4 video" })
    expect(detectMediaKind("song.mp3")).toEqual({ kind: "binary", label: "MP3 audio" })
    expect(detectMediaKind("bundle.zip")).toEqual({ kind: "binary", label: "ZIP archive" })
    expect(detectMediaKind("font.woff2")).toEqual({ kind: "binary", label: "WOFF2 font" })
  })

  it("falls through to text for unknown / missing extensions", () => {
    expect(detectMediaKind("README")).toEqual({ kind: "text" })
    expect(detectMediaKind("Makefile")).toEqual({ kind: "text" })
    expect(detectMediaKind("script.ts")).toEqual({ kind: "text" })
    expect(detectMediaKind("note.md")).toEqual({ kind: "text" })
    expect(detectMediaKind("foo.xyzunknown")).toEqual({ kind: "text" })
  })

  it("uses the last extension when the basename has multiple dots", () => {
    expect(detectMediaKind("archive.tar.gz")).toEqual({ kind: "binary", label: "gzip archive" })
    expect(detectMediaKind("a.b.png")).toEqual({ kind: "image", format: "png" })
  })

  it("strips leading directory components before extension probe", () => {
    expect(detectMediaKind("a/b/c/icon.png")).toEqual({ kind: "image", format: "png" })
  })
})

describe("parsePng", () => {
  /** Minimal PNG byte sequence — signature + IHDR length / type / width / height. */
  function pngBytes(width: number, height: number): Buffer {
    const buf = Buffer.alloc(24)
    // 8-byte PNG signature.
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    // IHDR chunk length (13) and type ("IHDR").
    buf.writeUInt32BE(13, 8)
    buf.set([0x49, 0x48, 0x44, 0x52], 12)
    // Width / height (big-endian).
    buf.writeUInt32BE(width, 16)
    buf.writeUInt32BE(height, 20)
    return buf
  }

  it("reads width/height from the IHDR chunk", () => {
    expect(parsePng(pngBytes(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it("returns null on bad signature", () => {
    const bad = pngBytes(10, 10)
    bad[0] = 0
    expect(parsePng(bad)).toBeNull()
  })

  it("returns null on truncated buffer", () => {
    expect(parsePng(Buffer.alloc(10))).toBeNull()
  })

  it("returns null on zero dimensions (corrupted header)", () => {
    expect(parsePng(pngBytes(0, 0))).toBeNull()
  })
})

describe("parseGif", () => {
  function gifBytes(version: "87a" | "89a", width: number, height: number): Buffer {
    const buf = Buffer.alloc(10)
    buf.write(`GIF${version}`, 0, "ascii")
    buf.writeUInt16LE(width, 6)
    buf.writeUInt16LE(height, 8)
    return buf
  }

  it("reads dimensions from a GIF89a logical screen descriptor", () => {
    expect(parseGif(gifBytes("89a", 640, 480))).toEqual({ width: 640, height: 480 })
  })

  it("reads dimensions from a GIF87a logical screen descriptor", () => {
    expect(parseGif(gifBytes("87a", 32, 16))).toEqual({ width: 32, height: 16 })
  })

  it("returns null on bad signature", () => {
    expect(parseGif(Buffer.from("XYZ89a    "))).toBeNull()
  })

  it("returns null on truncated buffer", () => {
    expect(parseGif(Buffer.alloc(5))).toBeNull()
  })
})

describe("parseJpeg", () => {
  /**
   * Build a minimal JPEG: SOI + APP0 (JFIF) + SOF0 (with our dimensions).
   * Real JPEGs have more segments before SOF; this is the smallest that
   * exercises the marker walk.
   */
  function jpegBytes(width: number, height: number): Buffer {
    const parts: Buffer[] = []
    // SOI
    parts.push(Buffer.from([0xff, 0xd8]))
    // APP0 marker + segment length (16) + "JFIF\0" + 1.01 + AspectRatio + 1x1 + thumb(0x0)
    const app0 = Buffer.alloc(18)
    app0[0] = 0xff
    app0[1] = 0xe0
    app0.writeUInt16BE(16, 2)
    app0.write("JFIF\0", 4, "ascii")
    app0[9] = 1
    app0[10] = 1
    app0[11] = 0
    app0.writeUInt16BE(1, 12)
    app0.writeUInt16BE(1, 14)
    app0[16] = 0
    app0[17] = 0
    parts.push(app0)
    // SOF0: marker + length (17) + precision (8) + height (BE) + width (BE) + components (3) + 3*3 placeholder
    const sof = Buffer.alloc(19)
    sof[0] = 0xff
    sof[1] = 0xc0
    sof.writeUInt16BE(17, 2)
    sof[4] = 8
    sof.writeUInt16BE(height, 5)
    sof.writeUInt16BE(width, 7)
    sof[9] = 3
    parts.push(sof)
    return Buffer.concat(parts)
  }

  it("reads width/height from the SOF0 segment", () => {
    expect(parseJpeg(jpegBytes(1024, 768))).toEqual({ width: 1024, height: 768 })
  })

  it("returns null on missing SOI", () => {
    expect(parseJpeg(Buffer.from([0xff, 0xe0, 0, 4, 0, 0]))).toBeNull()
  })

  it("returns null when SOF doesn't appear in the buffer", () => {
    // Only SOI; the walk runs off the end.
    expect(parseJpeg(Buffer.from([0xff, 0xd8]))).toBeNull()
  })
})

describe("parseWebp (VP8 lossy)", () => {
  function vp8Bytes(width: number, height: number): Buffer {
    // RIFF (4) + size (4 LE) + WEBP (4) + 'VP8 ' (4) + chunk size (4 LE)
    // + frame tag (3 bytes) + sync code (3 bytes) + width (2 LE, 14 bits) + height (2 LE, 14 bits)
    const buf = Buffer.alloc(32)
    buf.write("RIFF", 0, "ascii")
    buf.writeUInt32LE(24, 4)
    buf.write("WEBP", 8, "ascii")
    buf.write("VP8 ", 12, "ascii")
    buf.writeUInt32LE(16, 16)
    // tag + sync code (parser doesn't validate)
    buf[20] = 0
    buf[21] = 0
    buf[22] = 0
    buf[23] = 0x9d
    buf[24] = 0x01
    buf[25] = 0x2a
    buf.writeUInt16LE(width & 0x3fff, 26)
    buf.writeUInt16LE(height & 0x3fff, 28)
    return buf
  }

  it("reads dimensions from a VP8 lossy WEBP", () => {
    expect(parseWebp(vp8Bytes(1234, 567))).toEqual({ width: 1234, height: 567 })
  })

  it("returns null on bad RIFF/WEBP signature", () => {
    const bad = vp8Bytes(10, 10)
    bad.write("XXXX", 0, "ascii")
    expect(parseWebp(bad)).toBeNull()
  })
})

describe("parseImageHeader (dispatcher)", () => {
  it("routes by format", () => {
    const png = Buffer.alloc(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    png.writeUInt32BE(13, 8)
    png.set([0x49, 0x48, 0x44, 0x52], 12)
    png.writeUInt32BE(50, 16)
    png.writeUInt32BE(40, 20)
    expect(parseImageHeader(png, "png" satisfies ImageFormat)).toEqual({ width: 50, height: 40 })
  })

  it("returns null when the format-specific parser rejects", () => {
    expect(parseImageHeader(Buffer.from("not an image"), "png")).toBeNull()
  })
})

describe("formatBytes", () => {
  it("uses raw bytes under 1 KiB", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1023)).toBe("1023 B")
  })

  it("rolls to KiB at 1024 and keeps two decimal places below 10", () => {
    expect(formatBytes(1024)).toBe("1.00 KiB")
    expect(formatBytes(1536)).toBe("1.50 KiB")
  })

  it("drops to one decimal place between 10 and 100", () => {
    expect(formatBytes(20 * 1024)).toBe("20.0 KiB")
  })

  it("drops to zero decimal places at or above 100", () => {
    expect(formatBytes(150 * 1024)).toBe("150 KiB")
  })

  it("scales up through MiB / GiB", () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.00 MiB")
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GiB")
  })

  it("handles bad inputs without crashing", () => {
    expect(formatBytes(-1)).toBe("? B")
    expect(formatBytes(Number.NaN)).toBe("? B")
  })
})
