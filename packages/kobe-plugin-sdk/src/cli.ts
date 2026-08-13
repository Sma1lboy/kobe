/**
 * Call back into Rove through `$KOBE_BIN_PATH` — the portable plugin API.
 * `kobe()` is the raw runner; the named helpers wrap the high-value
 * Rove API verbs (full list: `rove api help` / `rove api schema`).
 */

import { execFile } from "node:child_process"

export interface KobeRunOptions {
  /** Defaults to `process.env.KOBE_BIN_PATH`. */
  readonly binPath?: string
  readonly cwd?: string
  /** Extra env merged over the inherited environment. */
  readonly env?: Record<string, string>
  /** Millis before the child is killed. Default 30_000. */
  readonly timeoutMs?: number
}

export interface KobeRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the Rove CLI with `<args…>`; resolves with the exit code (never rejects on non-zero). */
export function kobe(args: readonly string[], opts: KobeRunOptions = {}): Promise<KobeRunResult> {
  const bin = opts.binPath ?? process.env.KOBE_BIN_PATH
  if (!bin) return Promise.reject(new Error("KOBE_BIN_PATH is not set and no binPath was given"))
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

/** Run and parse stdout as JSON; throws on non-zero exit or bad JSON. */
export async function kobeJson<T = unknown>(args: readonly string[], opts: KobeRunOptions = {}): Promise<T> {
  const res = await kobe(args, opts)
  if (res.code !== 0) throw new Error(`Rove command ${args.join(" ")} exited ${res.code}: ${res.stderr.trim()}`)
  return JSON.parse(res.stdout) as T
}

/** Toast a notification in every attached Rove UI. */
export function notify(title: string, body?: string, opts?: KobeRunOptions): Promise<KobeRunResult> {
  return kobe(["api", "notify", "--title", title, ...(body ? ["--body", body] : [])], opts)
}

/** Send prompt text into a live engine session. */
export function dispatch(taskId: string, prompt: string, opts?: KobeRunOptions): Promise<KobeRunResult> {
  return kobe(["api", "dispatch", "--task-id", taskId, "--prompt", prompt], opts)
}

/** All tasks, as the daemon serializes them. */
export function listTasks<T = unknown>(opts?: KobeRunOptions): Promise<T> {
  return kobeJson<T>(["api", "list"], opts)
}

/** Open one of this plugin's own `[[panes]]` (qualified id: `you.plugin.pane`). */
export function openPane(qualifiedPaneId: string, opts?: KobeRunOptions): Promise<KobeRunResult> {
  return kobe(["plugin", "pane", "open", qualifiedPaneId], opts)
}

/**
 * Ask the human for a line of text via the host's input dialog
 * (`rove api prompt`). Resolves the entered string, or null when the user
 * cancelled / the prompt timed out / no TUI is attached. Blocks up to
 * `timeoutMs` (host default 120s), so pass a run timeout to match.
 */
export async function promptUser(
  title: string,
  opts: KobeRunOptions & { placeholder?: string; initial?: string; timeoutMs?: number } = {},
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
    const result = await kobeJson<{ value?: string; cancelled?: boolean }>(args, {
      ...run,
      timeoutMs: (timeoutMs ?? 120_000) + 10_000,
    })
    return typeof result.value === "string" ? result.value : null
  } catch {
    return null
  }
}
