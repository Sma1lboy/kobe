/**
 * Live cwd of a process — the scratch-task adoption read (issue #33): a
 * scratch shell "settles" wherever the user cd'd, and that directory (plus
 * a detected harness) decides which project group the row migrates into.
 *
 * macOS has no /proc, so the portable answer is `lsof -a -p <pid> -d cwd
 * -Fn` (one line per field, `n<path>` carries the directory). On Linux the
 * same lsof invocation works where installed; /proc/<pid>/cwd is tried
 * first as the cheap path. Null on any failure — an unknown cwd is "not
 * settled", never a guess.
 */

import { readlinkSync } from "node:fs"

/** Parse `lsof -Fn` output: the first `n`-prefixed line is the cwd path. */
export function parseLsofCwd(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith("n") && line.length > 1) return line.slice(1)
  }
  return null
}

/** Injectable for tests — the real one shells out to lsof. */
export type LsofCwd = (pid: number) => Promise<string>

export const lsofCwd: LsofCwd = async (pid) => {
  const proc = Bun.spawn(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  return await new Response(proc.stdout).text()
}

/** The process's current working directory, or null when unreadable. */
export async function processCwd(pid: number, lsof: LsofCwd = lsofCwd): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    /* no /proc (macOS) — fall through to lsof */
  }
  try {
    return parseLsofCwd(await lsof(pid))
  } catch {
    return null
  }
}
