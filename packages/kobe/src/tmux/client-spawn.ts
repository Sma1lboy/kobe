/**
 * Base spawn layer of the tmux client — the socket, argv builders, and the
 * run/capture wrappers every other tmux module goes through. Internal to
 * `src/tmux/`: everything here is re-exported (and documented) via
 * `./client.ts`, which stays the only import path outside this directory.
 */

import { homedir } from "node:os"

/**
 * Dedicated tmux socket name — isolates kobe's server from the user's,
 * AND isolates kobe environments from each other.
 *
 * Read from `KOBE_TMUX_SOCKET` (default `kobe`). The dev scripts set a
 * distinct value per environment (`dev:sandbox` → `kobe-sandbox`) so a
 * sandbox session never shares a server with production: `kill-server`,
 * `capture-pane`, and `list-sessions` are all naturally scoped to one
 * environment. This mirrors the existing per-`KOBE_HOME_DIR` daemon
 * socket isolation. Read once at module load — the env is fixed by the
 * launching shell before the process (or any child it spawns, including
 * the detached daemon and the tmux server's `run-shell` handlers, which
 * inherit it) starts.
 */
export const KOBE_TMUX_SOCKET = process.env.KOBE_TMUX_SOCKET?.trim() || "kobe"

/** Build a full `tmux -L kobe …` argv. */
export function tmuxArgs(...args: string[]): string[] {
  return ["tmux", "-L", KOBE_TMUX_SOCKET, ...args]
}

/**
 * tmux session name for a task. tmux disallows `.` and `:` in names
 * and matches a bare `-t name` as a prefix; we sanitize and always
 * target with `-t =name` (exact) at the call sites.
 */
export function tmuxSessionName(taskId: string): string {
  return `kobe-${taskId.replace(/[^A-Za-z0-9_-]/g, "")}`
}

/** argv that attaches to `name` (exact match). */
export function attachArgv(name: string): string[] {
  return tmuxArgs("attach-session", "-t", `=${name}`)
}

/** Read a child stream to a string, best-effort (`""` on any error). */
async function drainText(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return ""
  try {
    return await new Response(stream).text()
  } catch {
    return ""
  }
}

/**
 * cwd for every tmux child spawn — a directory guaranteed to outlive any
 * task's worktree.
 *
 * Each Tasks/Ops pane runs with its task's worktree as the process cwd.
 * Deleting a task unlinks that worktree, after which `Bun.spawn` fails
 * with `posix_spawn` ENOENT BEFORE the command runs — even though tmux is
 * on PATH — because the kernel can't resolve the inherited (now-gone)
 * cwd. Unanchored, that ENOENT throws straight into a pane's opentui loop
 * and crashes the whole pane to a bare shell when its task is deleted.
 * Anchoring to `$HOME` (→ `/` if unset) keeps the helpers spawnable from
 * a pane whose worktree just vanished. Read once — `$HOME` is fixed for
 * the process lifetime.
 */
export const SAFE_SPAWN_CWD = homedir() || "/"

/**
 * Run a tmux command, logging stderr when it fails. Silent tmux
 * errors are a foot-gun: a `split-window -t :0.0` that
 * failed because of `base-index 1` left the layout broken with no
 * trace. We only emit on a non-zero exit.
 *
 * stderr is drained CONCURRENTLY with the exit (not after it): if a
 * tmux invocation ever filled the stderr pipe buffer before exiting,
 * reading it only post-exit would dead-lock (the child blocks on the
 * write, we block on `exited`). tmux diagnostics are tiny in practice,
 * but the concurrent read removes the latent hang regardless.
 */
export async function runTmux(args: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(tmuxArgs(...args), {
      stdin: "ignore",
      cwd: SAFE_SPAWN_CWD,
      stdout: "ignore",
      stderr: "pipe",
    })
    const [errText, code] = await Promise.all([drainText(proc.stderr), proc.exited])
    if (code !== 0 && errText.trim().length > 0) {
      console.error(`[kobe tmux] ${args.join(" ")} (${code}): ${errText.trim()}`)
    }
    return code
  } catch {
    // posix_spawn itself failed (e.g. the pane's worktree cwd was just
    // deleted, or fd exhaustion). Degrade to a non-zero result so callers
    // running in a crash-net-less pane process see a failed command
    // instead of an unhandled rejection that kills the pane.
    return 1
  }
}

/** Run a tmux command without logging failures. Use only for existence probes. */
export async function runTmuxQuiet(args: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(tmuxArgs(...args), {
      stdin: "ignore",
      cwd: SAFE_SPAWN_CWD,
      stdout: "ignore",
      stderr: "ignore",
    })
    return await proc.exited
  } catch {
    return 1
  }
}

/** Flatten several tmux commands into one `tmux cmd \; cmd ...` invocation. */
export function tmuxCommandSequence(commands: readonly (readonly string[])[]): string[] {
  const out: string[] = []
  for (const cmd of commands) {
    if (cmd.length === 0) continue
    if (out.length > 0) out.push(";")
    out.push(...cmd)
  }
  return out
}

/** Run several tmux commands in one process. */
export async function runTmuxSequence(commands: readonly (readonly string[])[]): Promise<number> {
  const args = tmuxCommandSequence(commands)
  return args.length === 0 ? 0 : runTmux(args)
}

/**
 * Run a tmux command and capture stdout (stderr logged on failure).
 * Both streams are drained concurrently with the exit so neither a full
 * stdout (large capture-pane) nor a full stderr can dead-lock the call.
 */
export async function runTmuxCapturing(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn(tmuxArgs(...args), { stdin: "ignore", cwd: SAFE_SPAWN_CWD, stdout: "pipe", stderr: "pipe" })
    const [stdout, errText, code] = await Promise.all([drainText(proc.stdout), drainText(proc.stderr), proc.exited])
    if (code !== 0 && errText.trim().length > 0) {
      console.error(`[kobe tmux] ${args.join(" ")} (${code}): ${errText.trim()}`)
    }
    return { code, stdout }
  } catch {
    // See runTmux: a posix_spawn failure (deleted-worktree cwd, fd
    // exhaustion) degrades to an empty, non-zero capture rather than
    // throwing into a polling loop and crashing the pane. capturePaneById
    // already treats a non-zero code as `""`.
    return { code: 1, stdout: "" }
  }
}

/** Run several tmux commands in one process and capture combined stdout. */
export async function runTmuxSequenceCapturing(
  commands: readonly (readonly string[])[],
): Promise<{ code: number; stdout: string }> {
  const args = tmuxCommandSequence(commands)
  return args.length === 0 ? { code: 0, stdout: "" } : runTmuxCapturing(args)
}

/** Is the `tmux` binary on PATH? */
export async function tmuxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "-V"], { stdin: "ignore", cwd: SAFE_SPAWN_CWD, stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

/** Does a session with this exact name exist on kobe's socket? */
export async function sessionExists(name: string): Promise<boolean> {
  return (await runTmuxQuiet(["has-session", "-t", `=${name}`])) === 0
}

/**
 * Number of windows (chat tabs) in the session. `0` when the session
 * doesn't exist. Used to avoid a whole-session rebuild that would drop
 * sibling Ctrl+T chat-tab windows.
 */
export async function windowCount(sessionName: string): Promise<number> {
  const { code, stdout } = await runTmuxCapturing(["list-windows", "-t", `=${sessionName}`, "-F", "#{window_id}"])
  if (code !== 0) return 0
  return stdout.split("\n").filter((l) => l.trim().length > 0).length
}

/**
 * The session this process is running inside, resolved from `$TMUX_PANE`
 * (set by tmux for every pane command). Returns `null` when we're not in
 * a kobe tmux pane (e.g. the outer monitor) or tmux can't answer — the
 * caller then falls back to the in-pane dialog surface.
 */
export async function currentSessionName(): Promise<string | null> {
  const args = ["display-message", "-p"]
  const target = process.env.TMUX_PANE
  if (target && target.length > 0) args.push("-t", target)
  args.push("#{session_name}")
  const { code, stdout } = await runTmuxCapturing(args)
  const name = stdout.trim()
  return code === 0 && name.length > 0 ? name : null
}
