/**
 * tmux-backed interactive sessions (KOB-225).
 *
 * Interactive `claude` in the chat pane runs inside a tmux session
 * rather than an emulated-and-recomposited pane. This is the agent-deck
 * model (see `refs/agent-deck/internal/tmux/`): the session lives in a
 * tmux server, so it survives detach AND a kobe restart, and "entering"
 * it is a native `tmux attach` — full speed, zero emulation.
 *
 * NOTE on the "kobe deliberately does NOT use tmux" rule in `pty.ts`:
 * that still holds for the TERMINAL PANE's shell backend (Bun PTY). tmux
 * is used here only for interactive engine sessions, where persistence +
 * native attach are exactly what tmux is good at.
 *
 * Isolation: every command runs against a dedicated socket (`tmux -L
 * kobe …`), so the server, its options, and the no-prefix `Ctrl+Q`
 * detach binding never touch the user's own tmux server.
 */

/** Dedicated tmux socket name — isolates kobe's server from the user's. */
const SOCKET = "kobe"

function tmuxBase(...args: string[]): string[] {
  return ["tmux", "-L", SOCKET, ...args]
}

/**
 * tmux session name for a task. tmux disallows `.` and `:` in names and
 * matches a bare `-t name` as a prefix; we sanitize and always target
 * with `-t =name` (exact) at the call sites.
 */
export function tmuxSessionName(taskId: string): string {
  return `kobe-${taskId.replace(/[^A-Za-z0-9_-]/g, "")}`
}

/** argv that attaches to `name` (exact match). */
export function attachArgv(name: string): string[] {
  return tmuxBase("attach-session", "-t", `=${name}`)
}

async function runTmux(args: string[]): Promise<number> {
  const proc = Bun.spawn(tmuxBase(...args), { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  return await proc.exited
}

/** Is the `tmux` binary on PATH? */
export async function tmuxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "-V"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

/** Does a session with this exact name exist on kobe's socket? */
export async function sessionExists(name: string): Promise<boolean> {
  return (await runTmux(["has-session", "-t", `=${name}`])) === 0
}

/**
 * Ensure a detached session named `name` is running `command` in `cwd`.
 * No-op if it already exists (that's the persistence: a prior session
 * keeps running across detach / kobe restart). On first creation we also
 * set the server-scoped niceties — done after `new-session` so the server
 * is up, and idempotent so repeated creates are harmless.
 */
export async function ensureSession(opts: { name: string; cwd: string; command: readonly string[] }): Promise<void> {
  if (await sessionExists(opts.name)) return
  await runTmux(["new-session", "-d", "-s", opts.name, "-c", opts.cwd, opts.command.join(" ")])
  // Hide the tmux status bar so the pane looks like plain claude, and
  // make Ctrl+Q detach without a prefix (matches kobe's global ctrl+q
  // "back to the manager" convention). Both are server-scoped on the
  // dedicated `-L kobe` socket, so the user's own tmux is untouched.
  await runTmux(["set-option", "-g", "status", "off"])
  await runTmux(["bind-key", "-n", "C-q", "detach-client"])
}

/** Kill a session (if any). Used when a task is removed. */
export async function killSession(name: string): Promise<void> {
  if (await sessionExists(name)) await runTmux(["kill-session", "-t", `=${name}`])
}
