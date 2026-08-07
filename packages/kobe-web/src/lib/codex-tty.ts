/**
 * Codex CLI screen grammar (sampled live at v0.146) — the vendor-specific
 * pieces the shared prompt-glyph parser can't cover: Codex draws its slash
 * menu BELOW the composer (Claude draws it above), so the input-region tail
 * window must swallow the menu; and its welcome banner is a box frame
 * (`│ >_ OpenAI Codex (v0.146.0) │`) that folds into the same WelcomeCard
 * Claude's block-art banner uses.
 */

import type { ClaudeInputRegion } from "./claude-input.ts"
import { parseTtyBlocks, type TtyBlock } from "./claude-tty.ts"
import type { ColoredLine } from "./tty-color.ts"

const PROMPT = /^›($|\s)/
/** `› 1. Update now` — a selection cursor, not the composer. */
const OPTION_CURSOR = /^›\s*\d+\.\s/

/**
 * Codex composer: the LOWEST `› ` row. Everything below it is tail (status
 * row + an open slash menu, up to ~14 rows — Claude's 8-row window loses the
 * prompt the moment the menu opens).
 */
export function findCodexInputRegion(
  lines: readonly string[],
): ClaudeInputRegion | null {
  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === "") last--
  if (last < 0) return null
  for (let row = last; row >= 0 && last - row <= 14; row--) {
    const t = lines[row]
    if (!PROMPT.test(t)) continue
    // A selection dialog (`› 1. gpt-5.6-sol …`) REPLACES the composer. Keep
    // the screen translated: anchor a pseudo-region at the bottom hint row
    // ("Press enter to confirm…") so the dialog rows above parse as an
    // options block and keystrokes keep flowing to the PTY.
    if (OPTION_CURSOR.test(t)) {
      return { topRow: last, promptRow: last, promptText: "", statusLines: [] }
    }
    return {
      topRow: row,
      promptRow: row,
      promptText: t.slice(1).trim(),
      statusLines: lines
        .slice(row + 1, last + 1)
        .map((l) => l.trimEnd())
        .filter((l) => l.trim() !== ""),
    }
  }
  return null
}

const BOX_TOP = /^\s*╭─+╮\s*$/
const BOX_BOTTOM = /^\s*╰─+╯\s*$/
/** `>_ OpenAI Codex (v0.146.0)` → product + version. */
const CODEX_PRODUCT = /^(?:>_\s*)?(.+?)\s+\(v?(\d+\.\d+\.\d+)\)/

function boxInner(text: string): string {
  return text
    .replace(/^\s*│\s?/, "")
    .replace(/\s?│\s*$/, "")
    .trim()
}

interface Box {
  start: number
  end: number
  inner: string[]
}

function findBoxes(lines: readonly ColoredLine[]): Box[] {
  const boxes: Box[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!BOX_TOP.test(lines[i]?.text ?? "")) continue
    let j = i + 1
    while (j < lines.length && !BOX_BOTTOM.test(lines[j]?.text ?? "")) j++
    if (j >= lines.length) break
    boxes.push({
      start: i,
      end: j,
      inner: lines.slice(i + 1, j).map((l) => boxInner(l.text)),
    })
    i = j
  }
  return boxes
}

/**
 * Shared translation plus the Codex re-layout: the boxed welcome banner
 * becomes a welcome card (the `>_` glyph stands in for the logo), and an
 * update-available box folds into that card's right column as a notice —
 * most users never have one, so the card stays single-column.
 */
export function parseCodexBlocks(lines: readonly ColoredLine[]): TtyBlock[] {
  const boxes = findBoxes(lines)
  const welcomeBox = boxes.find((b) =>
    b.inner.some((t) => CODEX_PRODUCT.test(t)),
  )
  if (!welcomeBox) return parseTtyBlocks(lines)
  const noticeBox = boxes.find(
    (b) => b !== welcomeBox && b.inner.some((t) => /update available/i.test(t)),
  )
  const pm = welcomeBox.inner
    .find((t) => CODEX_PRODUCT.test(t))
    ?.match(CODEX_PRODUCT)
  if (!pm) return parseTtyBlocks(lines)
  const info = welcomeBox.inner
    .filter((t) => t !== "" && !CODEX_PRODUCT.test(t))
    .map((t) => t.replace(/\s{2,}/g, "  "))
  const welcome: TtyBlock = {
    kind: "welcome",
    welcome: {
      logo: [">_"],
      product: pm[1] ?? "Codex",
      version: pm[2] ?? "",
      info,
      vendor: "codex",
      ...(noticeBox
        ? { notice: noticeBox.inner.filter((t) => t !== "") }
        : {}),
    },
  }
  // Rebuild: both box ranges drop out; the welcome card lands where the
  // FIRST removed range began (notice box is usually drawn above it).
  const removed = [welcomeBox, ...(noticeBox ? [noticeBox] : [])].sort(
    (a, b) => a.start - b.start,
  )
  const out: TtyBlock[] = []
  let cursor = 0
  let welcomeEmitted = false
  for (const box of removed) {
    out.push(...parseTtyBlocks(lines.slice(cursor, box.start)))
    if (!welcomeEmitted) {
      out.push(welcome)
      welcomeEmitted = true
    }
    cursor = box.end + 1
  }
  out.push(...parseTtyBlocks(lines.slice(cursor)))
  return out
}
