/**
 * Call back into Rove through `$ROVE_BIN_PATH` (with `$KOBE_BIN_PATH` as a
 * compatibility fallback). `rove()` is the raw runner; named helpers wrap
 * Rove API verbs (full list: `rove api help` / `rove api schema`).
 */

import { execFile } from "node:child_process"

export interface RoveRunOptions {
  /** Defaults to `process.env.ROVE_BIN_PATH`, then `KOBE_BIN_PATH`. */
  readonly binPath?: string
  readonly cwd?: string
  /** Extra env merged over the inherited environment. */
  readonly env?: Record<string, string>
  /** Millis before the child is killed. Default 30_000. */
  readonly timeoutMs?: number
}

/** @deprecated Use RoveRunOptions. */
export type KobeRunOptions = RoveRunOptions

export interface RoveRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the Rove CLI with `<args…>`; resolves with the exit code (never rejects on non-zero). */
/** @deprecated Use RoveRunResult. */
export type KobeRunResult = RoveRunResult

export function rove(args: readonly string[], opts: RoveRunOptions = {}): Promise<RoveRunResult> {
  const bin = opts.binPath ?? process.env.ROVE_BIN_PATH ?? process.env.KOBE_BIN_PATH
  if (!bin) return Promise.reject(new Error("ROVE_BIN_PATH is not set and no binPath was given"))
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args as string[],
      {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        // Missing binary is a caller bug → reject; a non-zero exit is a
        // result → resolve with the code so callers can branch on it.
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err)
        const rawCode = err ? (err as { code?: unknown }).code : 0
        const code = typeof rawCode === "number" ? rawCode : err ? 1 : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

/** Compatibility alias for plugins written against the Kobe-named SDK. */
export const kobe = rove

/** Run and parse stdout as JSON; throws on non-zero exit or bad JSON. */
export async function roveJson<T = unknown>(args: readonly string[], opts: RoveRunOptions = {}): Promise<T> {
  const res = await rove(args, opts)
  if (res.code !== 0) throw new Error(`Rove command ${args.join(" ")} exited ${res.code}: ${res.stderr.trim()}`)
  return JSON.parse(res.stdout) as T
}

/** Compatibility alias for plugins written against the Kobe-named SDK. */
export const kobeJson = roveJson

/** Toast a notification in every attached Rove UI. */
export function notify(title: string, body?: string, opts?: RoveRunOptions): Promise<RoveRunResult> {
  return rove(["api", "notify", "--title", title, ...(body ? ["--body", body] : [])], opts)
}

/** Send prompt text into a live engine session. */
export function dispatch(taskId: string, prompt: string, opts?: RoveRunOptions): Promise<RoveRunResult> {
  return rove(["api", "dispatch", "--task-id", taskId, "--prompt", prompt], opts)
}

/** All tasks, as the daemon serializes them. */
export function listTasks<T = unknown>(opts?: RoveRunOptions): Promise<T> {
  return roveJson<T>(["api", "list"], opts)
}

/** Open one of this plugin's own `[[panes]]` (qualified id: `you.plugin.pane`). */
export function openPane(qualifiedPaneId: string, opts?: RoveRunOptions): Promise<RoveRunResult> {
  return rove(["plugin", "pane", "open", qualifiedPaneId], opts)
}

/**
 * Ask the human for a line of text via the host's input dialog
 * (`rove api prompt`). Resolves the entered string, or null when the user
 * cancelled / the prompt timed out / no TUI is attached. Blocks up to
 * `timeoutMs` (host default 120s), so pass a run timeout to match.
 */
export async function promptUser(
  title: string,
  opts: RoveRunOptions & { placeholder?: string; initial?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const { placeholder, initial, timeoutMs, ...run } = opts
  const args = [
    "api",
    "prompt",
    "--title",
    title,
    ...(placeholder ? ["--placeholder", placeholder] : []),
    ...(initial ? ["--initial", initial] : []),
    ...(timeoutMs ? ["--timeout", String(timeoutMs)] : []),
  ]
  try {
    const result = await roveJson<{ value?: string; cancelled?: boolean }>(args, {
      ...run,
      timeoutMs: (timeoutMs ?? 120_000) + 10_000,
    })
    return typeof result.value === "string" ? result.value : null
  } catch {
    return null
  }
}
