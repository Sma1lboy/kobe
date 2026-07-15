/**
 * `kobe doctor --report`: bundle the diagnosis + recent logs + relevant env
 * into one attachable text file, so a bug report carries the context the
 * maintainer needs instead of a screenshot of the summary.
 *
 * Only path-shaped env is emitted (KOBE_*, terminal, editor, shell) — never a
 * credential file's contents. `buildReportBundle` is pure (logs + env injected)
 * so the format is unit-testable without touching disk.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defaultDaemonLogPath, defaultPtyHostLogPath } from "@sma1lboy/kobe-daemon/daemon/paths"

/** Explicit non-secret env keys worth capturing, plus every KOBE_* var. */
const REPORT_ENV_KEYS = [
  "SHELL",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "VISUAL",
  "EDITOR",
] as const

function logTail(path: string, count: number): string {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-count)
      .join("\n")
  } catch {
    return ""
  }
}

/** `KEY=value` lines for the report's env section (path-shaped vars only). */
export function reportEnvLines(env: NodeJS.ProcessEnv): string[] {
  const keys = new Set<string>(REPORT_ENV_KEYS)
  for (const key of Object.keys(env)) if (key.startsWith("KOBE_")) keys.add(key)
  return [...keys].sort().map((key) => `${key}=${env[key] ?? "(unset)"}`)
}

/** Pure: assemble the bundle text from the diagnosis lines + injected logs/env. */
export function buildReportBundle(
  doctorLines: readonly string[],
  parts: { generatedAt: string; env: NodeJS.ProcessEnv; daemonLog: string; ptyLog: string },
): string {
  return [
    "# kobe doctor report",
    `generated: ${parts.generatedAt}`,
    "",
    "## diagnosis",
    ...doctorLines,
    "",
    "## environment",
    ...reportEnvLines(parts.env),
    "",
    "## daemon.log (last 200 lines)",
    parts.daemonLog || "(empty or absent)",
    "",
    "## pty-host.log (last 200 lines)",
    parts.ptyLog || "(empty or absent)",
    "",
  ].join("\n")
}

/** Write the bundle to `kobe-doctor-report.txt` in the cwd; return its path. */
export function writeReportBundle(doctorLines: readonly string[]): string {
  const path = join(process.cwd(), "kobe-doctor-report.txt")
  writeFileSync(
    path,
    buildReportBundle(doctorLines, {
      generatedAt: new Date().toISOString(),
      env: process.env,
      daemonLog: logTail(defaultDaemonLogPath(), 200),
      ptyLog: logTail(defaultPtyHostLogPath(), 200),
    }),
  )
  return path
}
