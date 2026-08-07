/**
 * Claude Code input-region parser — the "translate the TTY" layer for the
 * /chat terminal. Claude Code renders its composer as the last rows of the
 * screen: a horizontal rule, a `❯` prompt line, another rule, then 1-3
 * status lines (branch | ctx | quota …). Finding that region lets the GUI
 * overlay ITS input exactly where the native one sits, and re-render the
 * status rows as HTML — the kaku move.
 *
 * Engine-specific by design: this parses Claude Code's screen grammar, not
 * a generic TUI. Returns null whenever the grammar isn't found (a dialog is
 * open, another engine, scrolled up) — callers fall back to the raw
 * terminal, which is exactly the right degradation.
 */

export interface ClaudeInputRegion {
  /** Viewport row (0-based) where the input region starts — the rule above
   *  the prompt when present, else the prompt row itself. */
  topRow: number
  /** The prompt row itself. */
  promptRow: number
  /** Text after the prompt glyph — "" when the native composer is empty. */
  promptText: string
  /** Status lines below the prompt, ANSI-free plain text, rules dropped. */
  statusLines: string[]
  /** Mode label riding the composer's top rule (`──── ultracode ─`) — part
   *  of the INPUT BOX, not the transcript. */
  modeLabel?: string
}

/** A horizontal-rule row (the composer's frame lines). */
const RULE_RE = /^[─━═╌╍-]{4,}\s*$/
/** The top rule carrying a mode label: `──── ultracode ─`. */
const LABELED_RULE_RE = /^─{4,}[─\s]*(\S{1,24})\s*─{0,6}$/
/** A bare right-aligned label row (`ultracode ─`) just under its rule. */
const BARE_LABEL_RE = /^(\S{1,24})\s*─{0,6}$/
/** The prompt row: `❯ `, `› `, `> `, or the `)` claude v2 draws. */
const PROMPT_RE = /^[❯›>)]($|\s)/

/** How many rows below the prompt may hold status/rule lines (the expanded
 *  quota readout runs to five). */
const MAX_TAIL_ROWS = 8

/**
 * Find Claude Code's input region in the visible viewport rows.
 * Scans bottom-up: the LAST prompt-looking row within the tail window wins
 * (conversation text above may also start with `>`), and everything under
 * it becomes status lines.
 */
export function findClaudeInputRegion(
  lines: readonly string[],
): ClaudeInputRegion | null {
  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === "") last--
  if (last < 0) return null

  for (let row = last; row >= 0 && last - row <= MAX_TAIL_ROWS; row--) {
    if (!PROMPT_RE.test(lines[row])) continue
    // A `❯ 5. Chat about this` row is an AskUserQuestion SELECTION cursor, not
    // the text input — don't mistake it for the prompt (that leaked the option
    // into the composer). Let the scan fall through so no input region is
    // reported while a question is open.
    if (/^[❯›>)]\s*\d+\.\s/.test(lines[row])) return null
    // Absorb the composer's top frame UPWARD: plain rules, a rule carrying a
    // mode label (`──── ultracode ─`), or a bare label row sitting directly
    // under its rule. These rows are the INPUT BOX's chrome — leaving them
    // in the transcript stranded the mode label mid-scrollback.
    let top = row
    let modeLabel: string | undefined
    for (let k = 0; k < 3 && top > 0; k++) {
      const t = lines[top - 1].trim()
      if (RULE_RE.test(t)) {
        top -= 1
        continue
      }
      const lm = t.match(LABELED_RULE_RE)
      if (lm) {
        modeLabel = lm[1]
        top -= 1
        continue
      }
      const bm = modeLabel === undefined ? t.match(BARE_LABEL_RE) : null
      if (
        bm &&
        top > 1 &&
        (RULE_RE.test(lines[top - 2].trim()) ||
          LABELED_RULE_RE.test(lines[top - 2].trim()))
      ) {
        modeLabel = bm[1]
        top -= 1
        continue
      }
      break
    }
    const statusLines = lines
      .slice(row + 1, last + 1)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "" && !RULE_RE.test(line.trim()))
    return {
      topRow: top,
      promptRow: row,
      promptText: lines[row].slice(1).trim(),
      statusLines,
      ...(modeLabel ? { modeLabel } : {}),
    }
  }
  return null
}
