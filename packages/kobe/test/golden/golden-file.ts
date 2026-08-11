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

/** The exact commands the golden headers tell a reader to run. Exported so the
 *  instruction printed INTO each file is the real thing rather than a
 *  placeholder someone has to translate. */
export const REGENERATE_FAST = "KOBE_UPDATE_GOLDEN=1 bun run test:fast"
export const REGENERATE_RENDER = "KOBE_UPDATE_GOLDEN=1 bun run test:render"

/**
 * Rewrite goldens from the current behavior instead of comparing against them.
 *
 * Refused under CI on purpose. The flag turns every comparison in the process
 * into an unconditional pass, so an inherited `KOBE_UPDATE_GOLDEN=1` — left
 * exported in a shell, carried by a re-used job env — would rewrite all 19
 * committed fixtures from whatever the tree currently does and report the whole
 * golden suite green. On a developer machine `git status` is the signal that
 * happened; in CI there is no one reading it, so the mode simply does not
 * exist there.
 */
const UPDATE_REQUESTED = process.env.KOBE_UPDATE_GOLDEN === "1"
const IN_CI = process.env.CI === "true" || process.env.CI === "1" || process.env.GITHUB_ACTIONS === "true"
export const UPDATE_GOLDEN = UPDATE_REQUESTED && !IN_CI

if (UPDATE_REQUESTED && IN_CI) {
  throw new Error(
    "KOBE_UPDATE_GOLDEN=1 is set in CI. Golden update mode passes every comparison unconditionally, so honouring " +
      "it here would turn the golden gate into a no-op that rewrites its own fixtures. Unset it.",
  )
}
if (UPDATE_GOLDEN) {
  // Loud, once per process: update mode is a green run that proves nothing.
  console.warn(
    "[golden] KOBE_UPDATE_GOLDEN=1 — REWRITING goldens; every golden test passes by construction. Review `git diff`.",
  )
}

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
  report.push(`  if this change is intended: ${REGENERATE_FAST} (or ${REGENERATE_RENDER}), then review the diff`)
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
  regenerateCommand: string = REGENERATE_FAST,
): string {
  const out: string[] = [`# ${header}`, `# GENERATED — do not hand-edit. Regenerate: ${regenerateCommand}`]
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
