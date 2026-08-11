/**
 * Golden-file plumbing — the ONE mechanism both test tracks use to lock a
 * committed ground truth.
 *
 * A golden test does not describe behavior in prose assertions; it renders the
 * subject to canonical text and compares that text, byte for byte, against a
 * file in the repo. The file IS the specification: reviewing a diff to it is
 * reviewing the behavior change, and a change nobody meant to make cannot land
 * quietly because the diff shows up in the PR.
 *
 * Deliberately framework-free (`node:fs` only, no `expect`, no `describe`): the
 * pure-state matrix runs under vitest (`test:fast`) and the OpenTUI frame
 * captures run under `bun test` (`test:render`), and one helper has to serve
 * both. Callers own the assertion:
 *
 *     expect(matchGolden(GOLDEN, actual)).toBeNull()
 *
 * Regenerating after an INTENTIONAL change:
 *
 *     KOBE_UPDATE_GOLDEN=1 bun run test:fast     # state matrices
 *     KOBE_UPDATE_GOLDEN=1 bun run test:render   # OpenTUI frames
 *
 * then read the `git diff` before committing — an unexplained line in that
 * diff is the finding, not the noise.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

/** Rewrite goldens from the current behavior instead of comparing against them. */
export const UPDATE_GOLDEN = process.env.KOBE_UPDATE_GOLDEN === "1"

/** Resolve a golden path relative to the calling test file's own directory. */
export function goldenPath(importMetaUrl: string, name: string): string {
  return fileURLToPath(new URL(name, importMetaUrl))
}

/** How many differing lines a failure prints before it stops — enough to see
 *  the shape of a regression, few enough to stay readable in CI logs. */
const MAX_REPORTED_DIFFS = 12

/**
 * Compare `actual` against the golden at `absPath`.
 *
 * Returns `null` when they match (including in update mode, which rewrites the
 * file first), or a human-readable report of the first differing lines. A
 * MISSING golden is a failure rather than an auto-create: a golden that writes
 * itself on first run would pass its own first CI run while asserting nothing.
 */
export function matchGolden(absPath: string, actual: string): string | null {
  const normalized = actual.endsWith("\n") ? actual : `${actual}\n`
  if (UPDATE_GOLDEN) {
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, normalized, "utf8")
    return null
  }
  if (!existsSync(absPath)) {
    return `missing golden ${absPath}\n  regenerate with KOBE_UPDATE_GOLDEN=1, then review the diff before committing`
  }
  const expected = readFileSync(absPath, "utf8")
  if (expected === normalized) return null

  const expectedLines = expected.split("\n")
  const actualLines = normalized.split("\n")
  const report: string[] = [
    `golden mismatch: ${absPath}`,
    `  expected ${expectedLines.length} lines, got ${actualLines.length}`,
  ]
  let shown = 0
  for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i++) {
    if (expectedLines[i] === actualLines[i]) continue
    if (shown++ >= MAX_REPORTED_DIFFS) {
      report.push("  …")
      break
    }
    report.push(
      `  line ${i + 1}:`,
      `    - ${expectedLines[i] ?? "<missing>"}`,
      `    + ${actualLines[i] ?? "<missing>"}`,
    )
  }
  report.push("  if this change is intended: KOBE_UPDATE_GOLDEN=1 <the same test command>, then review the diff")
  return report.join("\n")
}

/**
 * Assemble a golden document from titled blocks.
 *
 * The header names the producing test and the regeneration command, so a
 * reader who opens the `.txt` alone — a reviewer scanning a diff, say — knows
 * what wrote it and never hand-edits it.
 */
export function goldenDocument(
  header: string,
  blocks: ReadonlyArray<{ title: string; lines: readonly string[] }>,
): string {
  const out: string[] = [
    `# ${header}`,
    "# GENERATED — do not hand-edit. Regenerate: KOBE_UPDATE_GOLDEN=1 <test command>",
  ]
  for (const block of blocks) {
    out.push("", `## ${block.title}`, ...block.lines)
  }
  return `${out.join("\n")}\n`
}

/** Pad to `width` for the fixed-column golden rows. Never truncates — a value
 *  that outgrows its column widens the row rather than losing information,
 *  which is `padEnd`'s own behaviour. */
export function pad(value: string, width: number): string {
  return value.padEnd(width)
}
