/**
 * TTY→blocks translation for Claude Code — the render layer works from the
 * REAL terminal viewport (colored lines), not the JSONL store. Color is
 * preserved verbatim; the restyle is light: user-prompt echoes become chat
 * bubbles, activity/spinner lines get a quieter treatment, blank runs collapse
 * to gaps. The ONE structural re-layout is the slash-command menu (see
 * parseTtyBlocks). Everything else renders as its original colored line — any
 * banner, box, or widget shows as the terminal drew it.
 */

import type { ColoredLine } from "./tty-color.ts"

export interface MenuItem {
  name: string
  desc: string
}

export type TtyBlock =
  | { kind: "user"; text: string }
  | { kind: "activity"; line: ColoredLine }
  | { kind: "menu"; items: MenuItem[] }
  | { kind: "line"; line: ColoredLine }
  | { kind: "gap" }

/** User prompt echo: `> hi` (v1) / `❯ hi` (v2). */
const USER_ECHO = /^[>❯›] /
/** Spinner / activity summary lines (`✻ Cooked for 5s`, `* Sautéed…`). */
const ACTIVITY = /^[✻✳✽✶✢✷✸✹✺✱*∗＊]\s+\S/
/** A slash-command menu row: `/name   description` (2+ spaces, then text). */
const MENU_ROW = /^(\/[a-zA-Z][\w:-]*)\s{2,}(\S.*)$/
/** Indented continuation of the previous menu row's wrapped description. */
const INDENTED = /^\s{2,}\S/

/**
 * Translate colored viewport lines (top → bottom) into display blocks. The
 * one structural re-layout is the slash-command menu: the native draws it as
 * two space-aligned columns (name | wrapped description), which leaves the
 * name column empty under each entry — a ragged block of dead vertical space.
 * We coalesce a run of 2+ `/name  desc` rows (plus wrapped continuations) into
 * a compact name/description list. Everything else renders verbatim.
 */
export function parseTtyBlocks(lines: readonly ColoredLine[]): TtyBlock[] {
  const blocks: TtyBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.text.trim()
    if (trimmed === "") {
      if (blocks[blocks.length - 1]?.kind !== "gap")
        blocks.push({ kind: "gap" })
      i += 1
      continue
    }
    if (USER_ECHO.test(trimmed)) {
      blocks.push({ kind: "user", text: trimmed.replace(USER_ECHO, "") })
      i += 1
      continue
    }
    if (ACTIVITY.test(trimmed)) {
      blocks.push({ kind: "activity", line })
      i += 1
      continue
    }
    if (MENU_ROW.test(trimmed)) {
      const items: MenuItem[] = []
      let j = i
      while (j < lines.length) {
        const t = lines[j].text.trim()
        const m = t.match(MENU_ROW)
        if (m) {
          items.push({ name: m[1], desc: m[2] })
          j += 1
        } else if (
          items.length > 0 &&
          t !== "" &&
          INDENTED.test(lines[j].text)
        ) {
          items[items.length - 1].desc += ` ${t}`
          j += 1
        } else break
      }
      if (items.length >= 2) {
        blocks.push({ kind: "menu", items })
        i = j
        continue
      }
    }
    blocks.push({ kind: "line", line })
    i += 1
  }
  while (blocks[0]?.kind === "gap") blocks.shift()
  while (blocks[blocks.length - 1]?.kind === "gap") blocks.pop()
  return blocks
}
