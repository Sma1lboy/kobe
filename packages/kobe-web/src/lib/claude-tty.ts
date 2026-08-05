/**
 * TTY→blocks translation for Claude Code — the render layer works from the
 * REAL terminal viewport (colored lines), not the JSONL store. Color is
 * preserved verbatim; the restyle is light: user-prompt echoes become chat
 * bubbles, activity/spinner lines get a quieter treatment, blank runs collapse
 * to gaps, and everything else renders as its original colored line. Any
 * slash-command UI, banner, box, or future widget shows up as the terminal
 * drew it — we re-lay-out what's on screen, never reimplement a widget.
 */

import type { ColoredLine } from "./tty-color.ts"

export type TtyBlock =
  | { kind: "user"; text: string }
  | { kind: "activity"; line: ColoredLine }
  | { kind: "line"; line: ColoredLine }
  | { kind: "gap" }

/** User prompt echo: `> hi` (v1) / `❯ hi` (v2). */
const USER_ECHO = /^[>❯›] /
/** Spinner / activity summary lines (`✻ Cooked for 5s`, `* Sautéed…`). */
const ACTIVITY = /^[✻✳✽✶✢✷✸✹✺✱*∗＊]\s+\S/

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
    if (ACTIVITY.test(trimmed)) {
      blocks.push({ kind: "activity", line })
      continue
    }
    blocks.push({ kind: "line", line })
  }
  while (blocks[0]?.kind === "gap") blocks.shift()
  while (blocks[blocks.length - 1]?.kind === "gap") blocks.pop()
  return blocks
}
