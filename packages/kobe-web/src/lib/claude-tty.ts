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

/** One AskUserQuestion choice (`❯ 1. 修改代码` + its indented description). */
export interface OptionItem {
  num: string
  text: string
  desc: string
  selected: boolean
}

/** The session-open banner (fox logo + `Claude Code vX.Y.Z` + model/cwd),
 *  re-laid-out as a card instead of raw art lines. `logo` is the left art
 *  column, `info` the remaining lines (model/billing, cwd). */
export interface WelcomeInfo {
  logo: string[]
  product: string
  version: string
  info: string[]
}

export type TtyBlock =
  | { kind: "user"; text: string }
  | { kind: "activity"; line: ColoredLine }
  | { kind: "menu"; items: MenuItem[] }
  | { kind: "options"; items: OptionItem[] }
  | { kind: "welcome"; welcome: WelcomeInfo }
  | { kind: "line"; line: ColoredLine }
  | { kind: "gap" }

/** User prompt echo: `> hi` (v1) / `❯ hi` (v2). The negative lookahead keeps
 *  a `❯ 1. option` AskUserQuestion cursor from being mistaken for a user
 *  message (it would render as a right-aligned bubble and shatter the list). */
const USER_ECHO = /^[>❯›] (?!\d+\.\s)/
/** Spinner / activity summary lines (`✻ Cooked for 5s`, `* Sautéed…`). The
 *  leading glyph is an ANIMATION frame, so the class must cover EVERY frame or
 *  the line flips body↔footer as it spins: Claude oscillates `· ✢ ✳ ✶ ✻ ✽`
 *  (the `·` middle-dot was missing and caused the flicker), plus the braille
 *  run `⠀-⣿` other engines default to, plus the v1 `*` star. */
const ACTIVITY = /^[·✢✳✶✻✽✷✸✹✺✱*∗＊⠀-⣿]\s+\S/
/** A slash-command menu row: `/name   description` (2+ spaces, then text). */
const MENU_ROW = /^(\/[a-zA-Z][\w:-]*)\s{2,}(\S.*)$/
/** An AskUserQuestion choice row: an optional `❯` cursor, then `N. text`. */
const OPTION_ROW = /^(❯\s*)?(\d+)\.\s+(.+)$/
/** The AskUserQuestion key-hint footer — not part of the option list. */
const OPTION_HINT = /^(Enter to|↑\/↓|Esc to|ctrl\+g)/
/** Indented continuation of the previous menu row's wrapped description. */
const INDENTED = /^\s{2,}\S/
/** Block-element glyphs the CLI's logo is drawn from (NOT box-drawing — those
 *  frame widgets we keep verbatim). A run of these rows at the top is the
 *  session banner. */
const LOGO_ART = /[█▉▊▋▌▍▎▏▀▄▐▖▗▘▙▚▛▜▝▞▟]/
/** `Claude Code v2.1.220` — product name (drawn by the CLI, not hard-coded)
 *  then a semver. Anchors welcome detection and feeds the version badge. */
const PRODUCT_VERSION = /^(.*?\S)\s+v?(\d+\.\d+\.\d+)\b/

/**
 * The session-open banner is the fox logo and the `Claude Code vX / model /
 * cwd` text drawn side-by-side on the SAME rows (logo in the left columns,
 * text to the right). Detect the leading run of block-art rows, split each at
 * the text column, and pull out product/version/info so the shell can render
 * a card instead of raw art. Returns null when the run isn't a banner.
 */
function matchWelcome(
  lines: readonly ColoredLine[],
  start: number,
): { welcome: WelcomeInfo; next: number } | null {
  let end = start
  while (end < lines.length && LOGO_ART.test(lines[end].text)) end += 1
  if (end - start < 2) return null
  const run = lines.slice(start, end)
  // Text column = leftmost start of a 3+ letter word across the run (the logo
  // art has none, so this is where "Claude"/"gpt"/"kobe" begin).
  let splitCol = Number.POSITIVE_INFINITY
  for (const l of run) {
    const m = l.text.match(/[A-Za-z]{3,}/)
    if (m?.index !== undefined) splitCol = Math.min(splitCol, m.index)
  }
  if (!Number.isFinite(splitCol)) return null
  const info = run.map((l) => l.text.slice(splitCol).trim())
  const vIdx = info.findIndex((t) => PRODUCT_VERSION.test(t))
  if (vIdx < 0) return null
  const vm = info[vIdx].match(PRODUCT_VERSION)
  if (!vm) return null
  const logo = run.map((l) => l.text.slice(0, splitCol).replace(/\s+$/, ""))
  const rest = info.filter((t, idx) => idx !== vIdx && t !== "")
  return {
    welcome: { logo, product: vm[1], version: vm[2], info: rest },
    next: end,
  }
}

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
    // The session-open banner (logo + version), re-laid-out as a card.
    if (LOGO_ART.test(line.text)) {
      const w = matchWelcome(lines, i)
      if (w) {
        blocks.push({ kind: "welcome", welcome: w.welcome })
        i = w.next
        continue
      }
    }
    if (USER_ECHO.test(trimmed)) {
      // Multi-line echo: continuations are 2-space indented (assistant output
      // starts at col 0) — absorb them + internal blanks into one bubble.
      let text = trimmed.replace(USER_ECHO, "")
      let j = i + 1
      while (j < lines.length) {
        const raw = lines[j].text
        const t = raw.trim()
        if (t === "") {
          const nextRaw = lines[j + 1]?.text ?? ""
          if (!/^ {2}\S/.test(nextRaw)) break
          text += "\n"
          j += 1
          continue
        }
        if (!/^ {2}\S/.test(raw) || ACTIVITY.test(t)) break
        text += `\n${t}`
        j += 1
      }
      blocks.push({ kind: "user", text })
      i = j
      continue
    }
    if (ACTIVITY.test(trimmed)) {
      blocks.push({ kind: "activity", line })
      i += 1
      continue
    }
    // AskUserQuestion choices: a run of `N. text` rows with a ❯ cursor on the
    // selected one (the cursor tells it apart from a plain prose list).
    if (OPTION_ROW.test(trimmed)) {
      const items: OptionItem[] = []
      let j = i
      let sawCursor = false
      while (j < lines.length) {
        const t = lines[j].text.trim()
        const om = t.match(OPTION_ROW)
        if (om) {
          const selected = t.startsWith("❯")
          if (selected) sawCursor = true
          items.push({ num: om[2], text: om[3], desc: "", selected })
          j += 1
        } else if (
          items.length > 0 &&
          t !== "" &&
          !OPTION_HINT.test(t) &&
          INDENTED.test(lines[j].text)
        ) {
          const last = items[items.length - 1]
          last.desc += last.desc ? ` ${t}` : t
          j += 1
        } else break
      }
      if (items.length >= 2 && sawCursor) {
        blocks.push({ kind: "options", items })
        i = j
        continue
      }
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
