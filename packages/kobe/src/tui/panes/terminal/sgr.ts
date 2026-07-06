import { parse } from "@ansi-tools/parser"

export type RGB = readonly [r: number, g: number, b: number]

export const ATTR = Object.freeze({
  BOLD: 1,
  DIM: 2,
  ITALIC: 4,
  UNDERLINE: 8,
  BLINK: 16,
  INVERSE: 32,
  HIDDEN: 64,
  STRIKETHROUGH: 128,
})

export interface Style {
  fg: RGB | undefined
  bg: RGB | undefined
  attributes: number
}

export interface Chunk {
  readonly text: string
  readonly fg?: RGB
  readonly bg?: RGB
  readonly attributes?: number
}

export const EMPTY_STYLE: Style = Object.freeze({
  fg: undefined,
  bg: undefined,
  attributes: 0,
})

export function ansi256ToRgb(index: number): RGB {
  if (index < 0) return [0, 0, 0]
  if (index < 16) return SYSTEM_PALETTE[index] ?? [0, 0, 0]
  if (index < 232) {
    const i = index - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i / 6) % 6)
    const b = i % 6
    const step = (n: number) => (n === 0 ? 0 : 55 + 40 * n)
    return [step(r), step(g), step(b)]
  }
  if (index < 256) {
    const gray = 8 + 10 * (index - 232)
    return [gray, gray, gray]
  }
  return [0, 0, 0]
}

const SYSTEM_PALETTE: readonly RGB[] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
]

function applySgr(prev: Style, rawParams: readonly string[]): Style {
  const params: number[] =
    rawParams.length === 0 ? [0] : rawParams.map((p) => (p === "" ? 0 : Number.parseInt(p, 10) || 0))
  let fg = prev.fg
  let bg = prev.bg
  let attr = prev.attributes
  let i = 0
  while (i < params.length) {
    const p = params[i]
    if (p === undefined) break
    if (p === 0) {
      fg = undefined
      bg = undefined
      attr = 0
      i += 1
      continue
    }
    if (p === 1) {
      attr |= ATTR.BOLD
      i += 1
      continue
    }
    if (p === 2) {
      attr |= ATTR.DIM
      i += 1
      continue
    }
    if (p === 3) {
      attr |= ATTR.ITALIC
      i += 1
      continue
    }
    if (p === 4) {
      attr |= ATTR.UNDERLINE
      i += 1
      continue
    }
    if (p === 5 || p === 6) {
      attr |= ATTR.BLINK
      i += 1
      continue
    }
    if (p === 7) {
      attr |= ATTR.INVERSE
      i += 1
      continue
    }
    if (p === 8) {
      attr |= ATTR.HIDDEN
      i += 1
      continue
    }
    if (p === 9) {
      attr |= ATTR.STRIKETHROUGH
      i += 1
      continue
    }
    if (p === 22) {
      attr &= ~(ATTR.BOLD | ATTR.DIM)
      i += 1
      continue
    }
    if (p === 23) {
      attr &= ~ATTR.ITALIC
      i += 1
      continue
    }
    if (p === 24) {
      attr &= ~ATTR.UNDERLINE
      i += 1
      continue
    }
    if (p === 25) {
      attr &= ~ATTR.BLINK
      i += 1
      continue
    }
    if (p === 27) {
      attr &= ~ATTR.INVERSE
      i += 1
      continue
    }
    if (p === 28) {
      attr &= ~ATTR.HIDDEN
      i += 1
      continue
    }
    if (p === 29) {
      attr &= ~ATTR.STRIKETHROUGH
      i += 1
      continue
    }
    if (p >= 30 && p <= 37) {
      fg = ansi256ToRgb(p - 30)
      i += 1
      continue
    }
    if (p >= 90 && p <= 97) {
      fg = ansi256ToRgb(p - 90 + 8)
      i += 1
      continue
    }
    if (p === 39) {
      fg = undefined
      i += 1
      continue
    }
    if (p >= 40 && p <= 47) {
      bg = ansi256ToRgb(p - 40)
      i += 1
      continue
    }
    if (p >= 100 && p <= 107) {
      bg = ansi256ToRgb(p - 100 + 8)
      i += 1
      continue
    }
    if (p === 49) {
      bg = undefined
      i += 1
      continue
    }
    if (p === 38) {
      const sub = params[i + 1]
      if (sub === 5) {
        const idx = params[i + 2] ?? 0
        fg = ansi256ToRgb(idx)
        i += 3
        continue
      }
      if (sub === 2) {
        const r = params[i + 2] ?? 0
        const g = params[i + 3] ?? 0
        const b = params[i + 4] ?? 0
        fg = [r, g, b]
        i += 5
        continue
      }
      i += 1
      continue
    }
    if (p === 48) {
      const sub = params[i + 1]
      if (sub === 5) {
        const idx = params[i + 2] ?? 0
        bg = ansi256ToRgb(idx)
        i += 3
        continue
      }
      if (sub === 2) {
        const r = params[i + 2] ?? 0
        const g = params[i + 3] ?? 0
        const b = params[i + 4] ?? 0
        bg = [r, g, b]
        i += 5
        continue
      }
      i += 1
      continue
    }
    i += 1
  }
  return { fg, bg, attributes: attr }
}

function sgrParamsFromRaw(raw: string): string[] {
  let body = raw
  if (body.charCodeAt(0) === 0x1b) body = body.slice(2)
  else if (body.charCodeAt(0) === 0x9b) body = body.slice(1)
  if (body.endsWith("m")) body = body.slice(0, -1)
  return body.split(";")
}

export function parseAnsiLine(input: string, initial: Style = EMPTY_STYLE): { chunks: Chunk[]; endStyle: Style } {
  if (input.length === 0) return { chunks: [], endStyle: initial }
  const out: Chunk[] = []
  let style: Style = { ...initial }
  let buf = ""
  const flush = () => {
    if (buf.length === 0) return
    const c: Chunk = {
      text: buf,
      ...(style.fg ? { fg: style.fg } : {}),
      ...(style.bg ? { bg: style.bg } : {}),
      ...(style.attributes !== 0 ? { attributes: style.attributes } : {}),
    }
    out.push(c)
    buf = ""
  }
  const codes = parse(input)
  for (const code of codes) {
    if (code.type === "TEXT") {
      buf += code.raw
      continue
    }
    if (code.type === "CSI" && code.command === "m") {
      flush()
      style = applySgr(style, sgrParamsFromRaw(code.raw))
    }
  }
  flush()
  return { chunks: out, endStyle: style }
}

export function parseAnsiSnapshot(input: string): Chunk[][] {
  const lines = input.split("\n")
  const rows: Chunk[][] = []
  let carry: Style = EMPTY_STYLE
  for (const line of lines) {
    const { chunks, endStyle } = parseAnsiLine(line, carry)
    rows.push(chunks)
    carry = endStyle
  }
  return rows
}
