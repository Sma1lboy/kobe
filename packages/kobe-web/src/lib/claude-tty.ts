/**
 * TTY→blocks translation for Claude Code — the render layer works from the
 * REAL terminal output, not the JSONL store. Each buffer line is classified
 * by Claude Code's screen grammar (⏺ bullets, > user echo, ✱ activity, ⎿
 * results, ╭─╮ boxes); recognized shapes get restyled HTML, and anything
 * unrecognized passes through verbatim — so every slash-command UI, banner,
 * or future widget renders without us reimplementing it.
 */

export type TtyBlock =
  | { kind: "box"; lines: string[] }
  | { kind: "user"; text: string }
  | { kind: "assistant"; lines: string[] }
  | { kind: "tool"; head: string; lines: string[] }
  | { kind: "activity"; text: string }
  | { kind: "gap" }
  | { kind: "raw"; text: string }

const BOX_TOP = /^\s*╭/
const BOX_BOTTOM = /^\s*╰/
const ACTIVITY = /^[✱✻✽✳✶✢·∗＊*][\s]/
/** `⏺ Name(args…` — a tool call line; bare `⏺ text` is assistant prose. */
const TOOL_HEAD = /^⏺ [A-Z][\w-]*\(/
const RESULT = /^\s*⎿/

/** Translate raw terminal lines (top → bottom) into display blocks. */
export function parseTtyBlocks(lines: readonly string[]): TtyBlock[] {
  const blocks: TtyBlock[] = []
  let i = 0

  const last = (): TtyBlock | undefined => blocks[blocks.length - 1]

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trimEnd()

    if (trimmed === "") {
      if (last()?.kind !== "gap") blocks.push({ kind: "gap" })
      i++
      continue
    }

    // Bordered box (welcome card, dialogs) — collect through the bottom rail;
    // an unterminated box degrades to raw lines.
    if (BOX_TOP.test(trimmed)) {
      const body: string[] = [trimmed]
      let j = i + 1
      while (j < lines.length && !BOX_BOTTOM.test(lines[j])) {
        body.push(lines[j].trimEnd())
        j++
      }
      if (j < lines.length) {
        body.push(lines[j].trimEnd())
        blocks.push({ kind: "box", lines: body })
        i = j + 1
        continue
      }
      blocks.push({ kind: "raw", text: trimmed })
      i++
      continue
    }

    // User prompt echo: `> hi` (v1) / `❯ hi` (v2). Only in the BODY — the
    // caller already sliced off the live input region, so a prompt glyph
    // here is an echoed past turn, not the composer.
    if (/^[>❯›] /.test(trimmed)) {
      blocks.push({ kind: "user", text: trimmed.replace(/^[>❯›] /, "") })
      i++
      continue
    }

    if (TOOL_HEAD.test(trimmed)) {
      blocks.push({ kind: "tool", head: trimmed.slice(2), lines: [] })
      i++
      continue
    }

    if (trimmed.startsWith("⏺")) {
      blocks.push({
        kind: "assistant",
        lines: [trimmed.replace(/^⏺\s?/, "")],
      })
      i++
      continue
    }

    // ⎿ result / continuation attaches to the preceding tool (or assistant).
    if (RESULT.test(trimmed)) {
      const prev = last()
      const text = trimmed.replace(/^\s*⎿\s?/, "")
      if (prev?.kind === "tool") prev.lines.push(text)
      else if (prev?.kind === "assistant") prev.lines.push(text)
      else blocks.push({ kind: "raw", text: trimmed })
      i++
      continue
    }

    if (ACTIVITY.test(trimmed)) {
      blocks.push({ kind: "activity", text: trimmed.replace(/^\S+\s/, "") })
      i++
      continue
    }

    // Two-space indent continues the assistant/tool block above (Claude's
    // wrap indent); otherwise it's a verbatim line.
    if (/^ {2,}\S/.test(line)) {
      const prev = last()
      if (prev?.kind === "assistant" || prev?.kind === "tool") {
        prev.lines.push(trimmed.trimStart())
        i++
        continue
      }
    }

    blocks.push({ kind: "raw", text: line.trimEnd() })
    i++
  }

  // Trim leading/trailing gaps.
  while (blocks[0]?.kind === "gap") blocks.shift()
  while (blocks[blocks.length - 1]?.kind === "gap") blocks.pop()
  return blocks
}
