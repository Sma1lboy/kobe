/**
 * TTY→blocks translation for Claude Code — the render layer works from the
 * REAL terminal viewport (colored lines), not the JSONL store. Color is
 * preserved verbatim: the only restyle is lifting user-prompt echoes into
 * chat bubbles and collapsing blank runs into gaps. Everything else renders
 * as its original colored line, so every slash-command UI, banner, box, or
 * future widget shows up exactly as the terminal drew it — we never
 * reimplement a widget, we just re-lay-out what's already on screen.
 */

import type { ColoredLine } from "./tty-color.ts"

export type TtyBlock =
  | { kind: "user"; text: string }
  | { kind: "line"; line: ColoredLine }
  | { kind: "gap" }

/** User prompt echo: `> hi` (v1) / `❯ hi` (v2). */
const USER_ECHO = /^[>❯›] /

/** Translate colored viewport lines (top → bottom) into display blocks. */
export function parseTtyBlocks(lines: readonly ColoredLine[]): TtyBlock[] {
  const blocks: TtyBlock[] = []
  for (const line of lines) {
    const trimmed = line.text.trimEnd()
    if (trimmed === "") {
      if (blocks[blocks.length - 1]?.kind !== "gap")
        blocks.push({ kind: "gap" })
      continue
    }
    if (USER_ECHO.test(trimmed)) {
      blocks.push({ kind: "user", text: trimmed.replace(USER_ECHO, "") })
      continue
    }
    blocks.push({ kind: "line", line })
  }
  // Trim leading/trailing gaps.
  while (blocks[0]?.kind === "gap") blocks.shift()
  while (blocks[blocks.length - 1]?.kind === "gap") blocks.pop()
  return blocks
}
