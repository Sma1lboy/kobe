/**
 * Composer `!shell` command runner — local subprocess for the
 * Claude-Code-style bash mode. Lifted in spirit from
 * `refs/claude-code/src/utils/Shell.ts` (single-shot exec, stdin closed,
 * stdout/stderr piped, abort-signal cancels via SIGTERM→SIGKILL).
 *
 * Scope (v1, KOB-83):
 *   - Runs the user's shell — `$SHELL` if it's bash/zsh, else falls
 *     back to `/bin/bash`. PowerShell unsupported; Windows untested.
 *   - Streams stdout/stderr separately so the chat row can render them
 *     in different colors.
 *   - CWD is the task's worktree path (passed in by the caller).
 *   - No PTY — interactive commands that prompt for input will hang
 *     until the user Ctrl-Cs. Matches Claude Code's choice; same
 *     limitation.
 *   - Hard 30-minute timeout (matches upstream).
 *
 * `node:child_process` (not `Bun.spawn`) for the same reason the
 * orchestrator's git helpers use it — kobe tests host under vitest /
 * Node where `Bun` is undefined. The streaming API is identical
 * enough between the two that switching later is a one-line change.
 */

import { type ChildProcess, spawn } from "node:child_process"

/** Default timeout, matches `refs/claude-code/src/utils/Shell.ts` `DEFAULT_TIMEOUT`. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** Sentinel exit code for "the child was killed via abort signal". Mirrors
 *  upstream's `interrupted: true` convention without inventing a new
 *  field — the renderer keys off `signal != null` to decide what to
 *  show. -1 is portable: no real exit code is negative. */
const ABORT_EXIT_CODE = -1

export interface RunBashCommandOpts {
  /** The literal command line (after `!` stripping). */
  readonly command: string
  /** Working directory. Required — no implicit default. */
  readonly cwd: string
  /** Streamed stdout chunks. Called zero or more times before resolution. */
  readonly onStdout: (chunk: string) => void
  /** Streamed stderr chunks. Called zero or more times before resolution. */
  readonly onStderr: (chunk: string) => void
  /** Cancels the child. Sends SIGTERM, then SIGKILL after a short grace. */
  readonly signal: AbortSignal
  /** Optional override; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

export interface RunBashCommandResult {
  /** Process exit code; `null` if killed by a signal. */
  readonly exitCode: number | null
  /** Signal name if the process exited via signal (`SIGTERM`, `SIGKILL`). */
  readonly signal: string | null
}

/**
 * Spawn a shell, stream output, await exit. Throws only for catastrophic
 * setup failures (e.g. shell binary not found) — non-zero exit codes
 * resolve normally so the caller can render the row with the failed
 * status instead of surfacing a runtime error.
 */
export async function runBashCommand(opts: RunBashCommandOpts): Promise<RunBashCommandResult> {
  const shell = resolveShell()

  return await new Promise<RunBashCommandResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(shell, ["-c", opts.command], {
        cwd: opts.cwd,
        // Closed stdin (no PTY). stdout/stderr piped so we can stream.
        // Inherit env so the user's $PATH, etc. flow through.
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        // Detached: false — we don't want our SIGINT cascade onto the
        // child (the parent TUI handles its own Ctrl-C). Default is
        // false on POSIX; setting explicitly for self-documentation.
        detached: false,
      })
    } catch (err) {
      reject(err)
      return
    }

    let settled = false
    const finish = (result: RunBashCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      opts.signal.removeEventListener("abort", onAbort)
      resolve(result)
    }

    // Stream stdout/stderr as UTF-8 text. The Buffer→string conversion
    // is async-safe (each `data` callback gets a complete chunk that
    // arrived in one read), but cross-chunk UTF-8 sequences would
    // mojibake on the boundary. Matches upstream's pragmatic choice;
    // CJK-heavy output may show a `�` at chunk seams.
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      opts.onStdout(chunk)
    })
    child.stderr?.on("data", (chunk: string) => {
      opts.onStderr(chunk)
    })

    child.on("error", (err) => {
      // Spawn-time failure — typically ENOENT for a missing shell. Resolve
      // with a synthetic non-zero code rather than rejecting so the chat
      // row renders the error message via onStderr.
      opts.onStderr(`(kobe: failed to spawn ${shell}: ${(err as Error).message})\n`)
      finish({ exitCode: ABORT_EXIT_CODE, signal: null })
    })

    child.on("exit", (code, signal) => {
      finish({ exitCode: code, signal: signal ?? null })
    })

    // Abort wiring — SIGTERM, then SIGKILL after 500 ms if the child
    // ignored the polite kill. Matches Claude Code's
    // wrapSpawn-in-Shell.ts cancel sequence.
    const onAbort = (): void => {
      if (settled) return
      try {
        child.kill("SIGTERM")
      } catch {
        // Already dead — fall through to finish via the exit handler.
      }
      setTimeout(() => {
        if (settled) return
        try {
          child.kill("SIGKILL")
        } catch {
          // Same as above.
        }
      }, 500).unref()
    }
    if (opts.signal.aborted) {
      onAbort()
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true })
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timeoutHandle = setTimeout(() => {
      if (settled) return
      opts.onStderr(`(kobe: command timed out after ${Math.round(timeoutMs / 1000)}s)\n`)
      try {
        child.kill("SIGTERM")
      } catch {
        /* exit handler will fire */
      }
    }, timeoutMs)
    timeoutHandle.unref()
  })
}

/**
 * Resolve which shell binary to invoke. Mirrors upstream's
 * `findSuitableShell` precedence:
 *   1. `$KOBE_BASH_SHELL` (kobe-specific escape hatch)
 *   2. `$SHELL` if it's bash or zsh
 *   3. `/bin/bash` fallback
 *
 * Anything else (fish, nu, …) won't accept the `-c` invocation
 * predictably, so we punt to bash. The user can override via env.
 */
function resolveShell(): string {
  const override = process.env.KOBE_BASH_SHELL
  if (override && override.length > 0) return override
  const userShell = process.env.SHELL ?? ""
  // Last path segment (handles `/usr/local/bin/zsh`, `/bin/bash`, …).
  const base = userShell.split("/").pop() ?? ""
  if (base === "bash" || base === "zsh") return userShell
  return "/bin/bash"
}
