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
//
// Expects packages/kobe/coverage/coverage-summary.json to exist
// (`cd packages/kobe && bun run coverage` first). A touched src file that is
// ABSENT from the summary counts as 0% — untested new modules fail loudly
// instead of slipping through.
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

if (!baseRef) {
  console.error("coverage-gate: BASE_REF is required")
  process.exit(2)
}
// Exemptions are PER FILE: each `coverage-exemption: <path> — <reason>` line
// exempts only the exact path it names (a bare reason with no path exempts nothing).
const exemptPaths = new Set(
  [...prBody.matchAll(/coverage-exemption:\s*(\S+)/gi)].map((m) => m[1]),
)

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

const summaryPath = resolve("packages/kobe/coverage/coverage-summary.json")
const summary = JSON.parse(readFileSync(summaryPath, "utf8"))

const diff = execSync(`git diff --name-only --diff-filter=ACMR origin/${baseRef}...HEAD`, { encoding: "utf8" })
const touched = diff
  .split("\n")
  .map((l) => l.trim())
  // .ts only — .tsx (opentui components) is outside the coverage scope; see vitest.config.ts.
  // .tsx render coverage is reported separately by `bun run test:render` (bun test +
  // @opentui/solid's testRender, see docs/HARNESS.md "render track") and uploaded to
  // Codecov alongside this report; it is NOT gated per-file here yet.
  .filter((f) => /^packages\/kobe\/src\/.*\.ts$/.test(f))
  .filter((f) => !f.endsWith(".d.ts"))

if (touched.length === 0) {
  console.log("No touched packages/kobe/src code files — coverage gate is a no-op.")
  process.exit(0)
}

// Summary keys are absolute paths; index by their repo-relative suffix.
const byRelative = new Map()
for (const key of Object.keys(summary)) {
  if (key === "total") continue
  const idx = key.replace(/\\/g, "/").indexOf("packages/kobe/src/")
  if (idx >= 0) byRelative.set(key.replace(/\\/g, "/").slice(idx), summary[key])
}

let fail = 0
for (const file of touched) {
  if (SUBPROCESS_ONLY_EXCLUSIONS.has(file)) {
    console.log(`::notice file=${file}::${file} is subprocess-only (behavior suite spawns the dist CLI) — excluded from the coverage gate.`)
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
        `Add tests for the changed behavior, or add a 'coverage-exemption: ${file} — <reason>' line to the PR body. ` +
        "See docs/HARNESS.md 'Coverage gate'.",
    )
    fail = 1
  } else {
    console.log(`ok ${file} — ${pct}%`)
  }
}
process.exit(fail)
