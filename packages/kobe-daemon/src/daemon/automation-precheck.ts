/**
 * Automation precheck: a shell command run BEFORE the engine starts, whose
 * exit code decides whether the run is worth doing at all.
 *
 * Why this exists: the dominant waste in scheduled agent work is firing on
 * time when nothing changed — the engine still boots, reads the repo, and
 * burns a turn to conclude "nothing to do". A precheck lets a cheap shell
 * command (`gh pr list ...`, `git log --since ...`) make that call for
 * roughly zero cost, so the expensive path only runs when there is work.
 *
 * Contract: exit 0 ⇒ proceed. Anything else — non-zero, timeout, spawn
 * failure — means SKIP. Failing closed is deliberate: a broken precheck must
 * not silently degrade into "run every time", which is the exact cost the
 * feature exists to avoid. The skip is recorded with its output so the user
 * can tell a healthy "nothing to do" from a broken command.
 *
 * Runs through the user's login shell so the command reads the same as it
 * would typed into a terminal (pipes, `&&`, PATH from their profile).
 * `resolveLoginShell` resolves to a bash even on Windows (Git Bash — see its
 * WSL caveat), so the `-lc` form is portable, matching the `-ilc` that
 * `session-launch.ts` already uses for engine spawns.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import type { AutomationPrecheck, AutomationPrecheckResult } from "./contracts.ts"
import { resolveLoginShell } from "./platform-shell.js"

/** Per-stream capture cap. Kept small — this is a decision signal, not a log. */
const MAX_OUTPUT_CHARS = 4000

/** Upper bound on a user-supplied timeout, so a typo can't wedge the sweep. */
const MAX_TIMEOUT_SECONDS = 600

function tail(chunks: readonly (Buffer | string)[]): string {
  const text = chunks.map((c) => c.toString()).join("")
  return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(-MAX_OUTPUT_CHARS)
}

/**
 * Run `precheck.command` in `cwd`. Never throws — a spawn failure resolves as
 * a non-zero result, because the caller's only question is "may I proceed",
 * and any answer other than a clean exit 0 is "no".
 */
export function runAutomationPrecheck(
  precheck: AutomationPrecheck,
  cwd: string,
  shell = resolveLoginShell({ fallback: "/bin/sh" }),
): Promise<AutomationPrecheckResult> {
  const startedAt = Date.now()
  const timeoutMs = Math.min(Math.max(precheck.timeoutSeconds, 1), MAX_TIMEOUT_SECONDS) * 1000

  // A missing cwd makes Node report `spawn <shell> ENOENT`, which reads as
  // "your shell is broken" and sends the user hunting in the wrong place. A
  // repo that moved or was deleted is the likelier story for a schedule that
  // has been running for weeks, so say that instead.
  if (!existsSync(cwd)) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: `working directory does not exist: ${cwd}`,
      durationMs: 0,
    })
  }

  return new Promise((resolve) => {
    const out: (Buffer | string)[] = []
    const err: (Buffer | string)[] = []
    let settled = false
    // Aborting fires the child's `error` event synchronously, BEFORE control
    // returns to the abort call site. Without this flag that error settles the
    // result first and a timeout gets misreported as a generic spawn failure —
    // which matters, because "your precheck hangs" and "your precheck is
    // broken" send the user to different places.
    let timedOut = false
    const controller = new AbortController()

    const finish = (exitCode: number | null, timedOut: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode,
        timedOut,
        stdout: tail(out),
        stderr: tail(err),
        durationMs: Date.now() - startedAt,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      // Belt and braces: if abort somehow did not settle us, do it here.
      finish(null, true)
    }, timeoutMs)
    timer.unref?.()

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ["-lc", precheck.command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        signal: controller.signal,
        killSignal: "SIGKILL",
      })
    } catch (spawnError) {
      // A bad shell path throws synchronously; same verdict as a bad exit.
      err.push(spawnError instanceof Error ? spawnError.message : String(spawnError))
      finish(null, false)
      return
    }

    child.stdout?.on("data", (chunk: Buffer | string) => out.push(chunk))
    child.stderr?.on("data", (chunk: Buffer | string) => err.push(chunk))
    // Our own abort arrives as an `error` too — attribute it to the timeout
    // rather than logging "The operation was aborted" as a spawn failure.
    child.on("error", (spawnError) => {
      if (timedOut) {
        finish(null, true)
        return
      }
      err.push(spawnError.message)
      finish(null, false)
    })
    child.on("close", (code) => finish(code, timedOut))
  })
}

/** Exit 0 and nothing else means "there is work to do". */
export function precheckPassed(result: AutomationPrecheckResult): boolean {
  return result.exitCode === 0 && !result.timedOut
}

/** One-line reason for the run record. */
export function formatPrecheckSkip(result: AutomationPrecheckResult): string {
  if (result.timedOut) return `precheck timed out after ${result.durationMs}ms`
  if (result.exitCode === null) return `precheck could not run: ${result.stderr.trim() || "unknown error"}`
  return `precheck exited ${result.exitCode}`
}
