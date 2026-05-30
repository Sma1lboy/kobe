/**
 * `kobe doctor` and `kobe reset` — packaged-build recovery (KOB-258).
 *
 * Dev has `bun run dev:sandbox:reset` (a `kobe kill-sessions` on the
 * sandbox tmux socket) to wipe a throwaway environment. The installed
 * (`npm i -g @sma1lboy/kobe`) build had no equivalent: when the daemon
 * wedged or died, a user had only scattered partial tools (`daemon
 * restart` = daemon only, `kill-sessions` = tmux only, `daemon status` =
 * report-but-don't-fix). These two commands close that gap:
 *
 *   - `kobe doctor`  — read-only. Diagnose daemon / tmux / state, and tail
 *                      daemon.log when the daemon is down. Mutates nothing.
 *   - `kobe reset`   — the prod equivalent of dev:sandbox:reset. Stops the
 *                      daemon (graceful → SIGTERM → SIGKILL), removes its
 *                      socket + pidfile, and kills all kobe tmux sessions.
 *                      `--hard` also wipes the task index + UI state.
 *                      NEVER touches git worktrees.
 *
 * The real wedge `reset` exists for: `startDaemonServer` unlinks the
 * socket before `listen`, so a stale socket FILE alone is harmless — the
 * trap is an OLD daemon process still alive but not servicing the socket
 * (pidfile → live pid). A fresh launch then steals the socket and you get
 * two daemons writing one `tasks.json`. `reset` makes the old one go away.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { KobeDaemonClient } from "../client/index.ts"
import { stopDaemonProcess } from "../daemon/lifecycle.ts"
import { defaultDaemonLogPath, defaultDaemonPidPath, defaultDaemonSocketPath } from "../daemon/paths.ts"
import { readPidFile } from "../daemon/server.ts"
import { homeDir, kobeStateDir, kvStatePath } from "../env.ts"
import { KOBE_TMUX_SOCKET, tmuxArgs, tmuxAvailable } from "../tmux/client.ts"

/** `kill(pid, 0)` throws ESRCH once a process is gone; EPERM means it's
 *  alive but owned by someone else. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Connect-and-ask `daemon.status`. Returns null if the daemon isn't
 *  reachable. Read-only: {@link KobeDaemonClient} only dials the socket,
 *  it never spawns a daemon, so calling this can't accidentally start one. */
async function probeDaemonStatus(socketPath: string): Promise<Record<string, unknown> | null> {
  const client = new KobeDaemonClient(socketPath)
  try {
    return await client.request<Record<string, unknown>>("daemon.status")
  } catch {
    return null
  } finally {
    client.close()
  }
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** "present (4.2 KB, modified 2026-05-29T…)" or "absent". */
function describeFile(path: string): string {
  try {
    const st = statSync(path)
    return `present (${fmtBytes(st.size)}, modified ${st.mtime.toISOString()})`
  } catch {
    return "absent"
  }
}

/** Number of tasks recorded in a v3 `tasks.json`, or null if unreadable. */
function taskCount(tasksPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(tasksPath, "utf8")) as { tasks?: unknown[] }
    return Array.isArray(parsed.tasks) ? parsed.tasks.length : null
  } catch {
    return null
  }
}

/** Last `n` non-empty lines of a file, or "" if missing/unreadable. */
function tailFile(path: string, n: number): string {
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
    return lines.slice(-n).join("\n")
  } catch {
    return ""
  }
}

/** Run a tmux command on kobe's socket, swallowing the "no server
 *  running" stderr that `runTmux`/`runTmuxCapturing` would otherwise log.
 *  doctor/reset treat an absent server as a normal state, not an error. */
async function tmuxQuiet(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(tmuxArgs(...args), { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  // Drain stdout CONCURRENTLY with awaiting exit (the runTmuxCapturing
  // pattern, KOB-244) so a large `list-sessions` can never fill the pipe
  // buffer and wedge the call.
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text().catch(() => ""), proc.exited])
  return { code, stdout }
}

/** Count of sessions on kobe's tmux server (0 when no server is running). */
async function kobeSessionCount(): Promise<number> {
  if (!(await tmuxAvailable())) return 0
  const { code, stdout } = await tmuxQuiet(["list-sessions", "-F", "#{session_name}"])
  if (code !== 0) return 0
  return stdout.split("\n").filter((l) => l.trim().length > 0).length
}

/**
 * `kobe doctor` — read-only health check. Never kills, unlinks, or wipes;
 * it only reports and recommends. The fix is `kobe reset` / `kobe daemon
 * restart`, surfaced in the output.
 */
export async function runDoctorSubcommand(): Promise<void> {
  const socketPath = defaultDaemonSocketPath()
  const pidPath = defaultDaemonPidPath()
  const logPath = defaultDaemonLogPath()
  const tasksPath = join(kobeStateDir(), "tasks.json")
  const statePath = kvStatePath()

  const out: string[] = ["kobe doctor", `  home:   ${homeDir()}`, `  socket: ${socketPath}`, ""]

  // --- Daemon ---------------------------------------------------------
  const status = await probeDaemonStatus(socketPath)
  if (status) {
    const pid = typeof status.daemonPid === "number" ? status.daemonPid : "?"
    const up = typeof status.uptimeMs === "number" ? fmtDuration(status.uptimeMs) : "?"
    const tasks = typeof status.taskCount === "number" ? status.taskCount : "?"
    const clients = typeof status.attachedClients === "number" ? status.attachedClients : "?"
    out.push(`daemon:  ✓ running (pid ${pid}, up ${up}, ${tasks} task(s), ${clients} client(s))`)
  } else {
    const pid = await readPidFile(pidPath)
    if (pid && isProcessAlive(pid)) {
      out.push(`daemon:  ✗ WEDGED — process alive (pid ${pid}) but not accepting connections`)
      out.push("         → run `kobe reset` to kill it, then relaunch kobe")
    } else if (pid) {
      out.push(`daemon:  ✗ not running (stale pidfile → pid ${pid} is gone)`)
      out.push("         → harmless; relaunch kobe, or `kobe reset` to clear the stale pidfile")
    } else {
      out.push("daemon:  ✗ not running (no pidfile)")
    }
    if (existsSync(socketPath)) out.push(`         orphan socket file present: ${socketPath}`)
    const tail = tailFile(logPath, 8)
    if (tail) {
      out.push("         last lines of daemon.log:")
      for (const line of tail.split("\n")) out.push(`         │ ${line}`)
    }
  }
  out.push("")

  // --- tmux -----------------------------------------------------------
  if (await tmuxAvailable()) {
    out.push(`tmux:    ${await kobeSessionCount()} kobe session(s) on \`${KOBE_TMUX_SOCKET}\` socket`)
  } else {
    out.push("tmux:    ✗ not found on PATH (task sessions need tmux)")
  }
  out.push("")

  // --- State files ----------------------------------------------------
  const count = taskCount(tasksPath)
  out.push(`tasks.json: ${describeFile(tasksPath)}${count === null ? "" : ` — ${count} task(s)`}`)
  out.push(`state.json: ${describeFile(statePath)}`)
  out.push(`daemon.log: ${describeFile(logPath)}`)

  console.log(out.join("\n"))
}

/** Interactive y/N confirm on a TTY. Returns false on anything but yes. */
async function confirmTty(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve))
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** Best-effort delete of a kobe state file. ENOENT is success (already
 *  gone); any other error is reported but non-fatal. */
async function removeStateFile(path: string, label: string): Promise<void> {
  try {
    await unlink(path)
    console.log(`  removed ${label} (${path})`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`  ${label}: already absent`)
    } else {
      console.error(`  failed to remove ${label} (${path}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * `kobe reset [--hard] [--yes]` — the packaged equivalent of
 * `dev:sandbox:reset`. Tears down the daemon + all kobe tmux sessions so a
 * fresh `kobe` launch starts clean. `--hard` additionally wipes the task
 * index + UI state. Git worktrees (and everything under
 * `.claude/worktrees/`) are NEVER touched. Does not respawn the daemon —
 * relaunch kobe for that.
 *
 * Confirmation: interactive y/N on a TTY; `--yes`/`-y` skips it; on a
 * non-TTY without `--yes` it prints the plan and exits without acting.
 */
export async function runResetSubcommand(argv: readonly string[]): Promise<void> {
  const hard = argv.includes("--hard")
  const yes = argv.includes("--yes") || argv.includes("-y")

  const socketPath = defaultDaemonSocketPath()
  const pidPath = defaultDaemonPidPath()
  const tasksPath = join(kobeStateDir(), "tasks.json")
  const statePath = kvStatePath()

  console.log("kobe reset will:")
  console.log("  • stop the kobe daemon (graceful → SIGTERM → SIGKILL)")
  console.log(`  • remove its socket + pidfile (${socketPath})`)
  console.log(`  • kill all kobe tmux sessions on the \`${KOBE_TMUX_SOCKET}\` socket`)
  if (hard) {
    const count = taskCount(tasksPath)
    console.log(`  • DELETE the task index${count === null ? "" : ` (${count} task(s))`} — ${tasksPath}`)
    console.log(`  • DELETE the UI state — ${statePath}`)
  }
  console.log("  • NOT touch your git worktrees or any code under .claude/worktrees/")
  if (!hard) {
    console.log("  (your task list & worktrees are kept — add --hard to also wipe the task index + UI state)")
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log("\nre-run with --yes to proceed (no interactive terminal for a y/N prompt)")
      return
    }
    const ok = await confirmTty(
      hard
        ? "\nStop daemon, kill sessions AND wipe task index? [y/N] "
        : "\nStop daemon and kill kobe sessions? [y/N] ",
    )
    if (!ok) {
      console.log("aborted — nothing changed")
      return
    }
  }

  console.log("")
  // 1. Daemon: stop + confirm-dead + remove socket/pidfile.
  const { pid, method } = await stopDaemonProcess(socketPath, pidPath)
  console.log(
    method === "absent"
      ? "  daemon: was not running (cleared any stale socket/pidfile)"
      : `  daemon: stopped via ${method}${pid ? ` (pid ${pid})` : ""}`,
  )

  // 2. tmux: kill the whole kobe server (all task sessions at once).
  if (await tmuxAvailable()) {
    const { code } = await tmuxQuiet(["kill-server"])
    console.log(
      code === 0
        ? `  tmux: killed all sessions on \`${KOBE_TMUX_SOCKET}\``
        : `  tmux: no sessions on \`${KOBE_TMUX_SOCKET}\``,
    )
  } else {
    console.log("  tmux: not installed — no sessions to kill")
  }

  // 3. Hard wipe: task index + UI state (still NOT worktrees).
  if (hard) {
    await removeStateFile(tasksPath, "task index")
    await removeStateFile(statePath, "UI state")
  }

  console.log("\nkobe: reset complete. Relaunch kobe to start fresh.")
}
