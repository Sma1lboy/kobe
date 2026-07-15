#!/usr/bin/env bun
// Per-touched-file coverage gate (the coverage sibling of ci.yml's
// file-size-cap job). Philosophy: no global % threshold — a repo-wide bar
// invites filler tests. Instead, every code file a PR TOUCHES must meet a
// line-coverage floor, so coverage ratchets up exactly where work happens:
// touch it → you test it.
//
// Inputs (env):
//   BASE_REF            PR base branch (required) — diff is origin/BASE...HEAD
//   PR_BODY             PR description; `coverage-exemption: <path> — <reason>` lines exempt the named files
//   KOBE_COVERAGE_MIN   line-% floor for touched files (default 50)
//   KOBE_RENDER_COVERAGE 1 selects bun test's OpenTUI lcov report
//
// Default mode expects packages/kobe/coverage/coverage-summary.json to exist
// (`cd packages/kobe && bun run coverage` first). Render mode
// (`KOBE_RENDER_COVERAGE=1`) consumes test:render's lcov instead. A touched
// source file that is ABSENT from its applicable report counts as 0% — an
// untested new module fails loudly instead of slipping through.
//
// SUBPROCESS_ONLY_EXCLUSIONS below (KOB-11) is a small, hand-verified list of
// entry files exercised only by test/behavior/'s spawned dist-CLI subprocess
// (vitest's v8 coverage can't attribute a child process) — not a general
// escape hatch, see the comment at its definition.

import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const MIN = Number(process.env.KOBE_COVERAGE_MIN ?? "50")
const baseRef = process.env.BASE_REF
const prBody = process.env.PR_BODY ?? ""
const renderCoverage = process.env.KOBE_RENDER_COVERAGE === "1"

if (!baseRef) {
  console.error("coverage-gate: BASE_REF is required")
  process.exit(2)
}
// Exemptions are PER FILE: each `coverage-exemption: <path> — <reason>` line
// exempts only the exact path it names (a bare reason with no path exempts nothing).
const exemptPaths = new Set([...prBody.matchAll(/coverage-exemption:\s*(\S+)/gi)].map((m) => m[1]))

// KOB-11 blind spot: files whose ONLY real exercise is the behavior suite
// spawning the built CLI as a subprocess (test/behavior/harness.ts's
// runKobe() → `spawnSync("bun", [DIST_CLI, ...])`) always read 0% here —
// vitest's v8 coverage instruments its own process, not a child `bun`
// process. A per-file floor would permanently block touching these files
// without lcov-merging the behavior run in (out of scope for now — see
// docs/HARNESS.md "Coverage gate"). Verified 2026-07-07 against the current
// tree: `bun run coverage` + this file's summary.
//
// This is NOT "every low-coverage src/cli/* file" — most CLI dispatch files
// (theme.ts, repo-cmd.ts, index.ts, daemon-cmd.ts, ...) now have direct unit
// tests (test/cli/*.test.ts) and clear the floor normally. Only add a path
// here if it is a subprocess-only entry point with no (and no plausible)
// direct unit test — re-verify before adding, don't grow this defensively.
const SUBPROCESS_ONLY_EXCLUSIONS = new Set([
  // `kobe pty-host`: internal subcommand spawned DETACHED by
  // ensurePtyHostReachable() (see src/cli/pty-host-cmd.ts) — it blocks in the
  // foreground running a real server and installs SIGINT/SIGTERM handlers
  // that call process.exit(), so invoking runPtyHostSubcommand() directly
  // from a unit test would hang/kill the test runner. Not reachable from
  // test/behavior/ either (no test drives `kobe pty-host` today) — it is
  // exercised only by the real running app. The real server logic it wraps
  // (startPtyHostServer) lives in packages/kobe-daemon and is tested there;
  // this file is just the thin CLI-dispatch shim.
  "packages/kobe/src/cli/pty-host-cmd.ts",
])

// tui-react React-integration files (hooks + wiring that import react or
// @opentui/react at runtime) can only execute under the RENDER track (bun
// test + @opentui/react's testRender, docs/HARNESS.md) — vitest's node env
// never imports/runs them, so v8 reports 0% here. This is the .ts analog of
// excluding .tsx: the render gate selects them alongside .tsx files. Scoped
// to tui-react/ so a pure-logic file living
// there (e.g. workspace/keybinding-gates.ts — no react import) stays gated;
// a VALUE import is the signal, since `import type … from "react"` is erased
// at compile time and does not block vitest from executing the module.
const RENDER_VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*?\bfrom\s+["'](?:react|@opentui\/react)["']/m
function isRenderTrackOnly(file) {
  if (!file.startsWith("packages/kobe/src/tui-react/")) return false
  try {
    return RENDER_VALUE_IMPORT.test(readFileSync(file, "utf8"))
  } catch {
    return false
  }
}

function renderCoverageSummary(path) {
  const byRelative = new Map()
  let source = null
  let found = 0
  let total = 0
  const finish = () => {
    if (source === null) return
    const normal = source.replace(/\\/g, "/")
    const index = normal.indexOf("packages/kobe/src/")
    const relative = index >= 0 ? normal.slice(index) : normal.startsWith("src/") ? `packages/kobe/${normal}` : null
    if (relative !== null) byRelative.set(relative, { lines: { pct: total === 0 ? 100 : (found / total) * 100 } })
    source = null
    found = 0
    total = 0
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("SF:")) {
      finish()
      source = line.slice(3)
    } else if (line.startsWith("DA:")) {
      const hits = Number(line.slice(3).split(",")[1])
      total++
      if (hits > 0) found++
    } else if (line === "end_of_record") {
      finish()
    }
  }
  finish()
  return byRelative
}

let byRelative
if (renderCoverage) {
  byRelative = renderCoverageSummary(resolve("packages/kobe/coverage-render/lcov.info"))
} else {
  const summaryPath = resolve("packages/kobe/coverage/coverage-summary.json")
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"))
  // Summary keys are absolute paths; index by their repo-relative suffix.
  byRelative = new Map()
  for (const key of Object.keys(summary)) {
    if (key === "total") continue
    const index = key.replace(/\\/g, "/").indexOf("packages/kobe/src/")
    if (index >= 0) byRelative.set(key.replace(/\\/g, "/").slice(index), summary[key])
  }
}

const diff = execSync(`git diff --name-only --diff-filter=ACMR origin/${baseRef}...HEAD`, { encoding: "utf8" })
const touched = diff
  .split("\n")
  .map((l) => l.trim())
  .filter((file) => {
    if (renderCoverage) return /^packages\/kobe\/src\/.*\.tsx$/.test(file) || isRenderTrackOnly(file)
    return /^packages\/kobe\/src\/.*\.ts$/.test(file) && !isRenderTrackOnly(file)
  })
  .filter((f) => !f.endsWith(".d.ts"))

if (touched.length === 0) {
  console.log(`No touched ${renderCoverage ? "render-track" : "vitest-track"} source files — coverage gate is a no-op.`)
  process.exit(0)
}

let fail = 0
for (const file of touched) {
  if (SUBPROCESS_ONLY_EXCLUSIONS.has(file)) {
    console.log(
      `::notice file=${file}::${file} is subprocess-only (behavior suite spawns the dist CLI) — excluded from the coverage gate.`,
    )
    continue
  }
  const entry = byRelative.get(file)
  const pct = entry ? entry.lines.pct : 0
  if (pct < MIN) {
    if (exemptPaths.has(file)) {
      console.log(`::notice file=${file}::${file} is ${pct}% but exempted by the PR body.`)
      continue
    }
    console.log(
      `::error file=${file}::${file} line coverage is ${pct}% (floor ${MIN}% on touched files). ` +
        `Add ${renderCoverage ? "a bun-test render test" : "a vitest test"} for the changed behavior, or add a 'coverage-exemption: ${file} — <reason>' line to the PR body. See docs/HARNESS.md 'Coverage gate'.`,
    )
    fail = 1
  } else {
    console.log(`ok ${file} — ${pct}%`)
  }
}
process.exit(fail)
