/**
 * tmux orchestrator bootstrap — KOB-213 sprint-1 skeleton.
 *
 * Public entry: `maybeBootstrapTmux()`. Called from `cli/index.ts`
 * just before `startTui`. Returns early (so the existing in-process TUI
 * path runs) when any of the following hold:
 *
 *   - We are already inside tmux (`$TMUX` set) — avoids recursion when
 *     the user reruns `kobe` inside the kobe tmux session itself.
 *   - The escape hatch `KOBE_TMUX=0` is set — keeps the legacy code path
 *     reachable while the rewrite is in flight.
 *   - stdin or stdout is not a TTY — non-interactive launches (CI,
 *     piped runs) can't drive an interactive tmux client.
 *   - tmux is not installed.
 *
 * Otherwise: spawn a fresh tmux session named `kobe-<short-id>`, build
 * the 5-pane skeleton (see `layout.ts`) and the status line (see
 * `status-line.ts`), then `tmux attach-session` with inherited stdio.
 * When the user detaches (`Ctrl-B d`) or kills the session, kobe exits
 * with tmux's exit code — true `execvp` would be nicer but this is the
 * spike. Each kobe launch gets its own session; we never reuse names.
 *
 * Pane targeting strategy: tmux pane numeric indices respect the
 * user's `base-index` / `pane-base-index` settings, so the bootstrap
 * captures pane IDs (`%N` form) from each `-P -F '#{pane_id}'`
 * invocation and feeds them back as `-t` targets. This works
 * regardless of the user's tmux config.
 */

import { spawnSync as nodeSpawnSync } from "node:child_process"
import { execSync } from "node:child_process"
import pkg from "../../package.json" with { type: "json" }
import { buildBindKeyArgs } from "./keybindings.ts"
import { DEFAULT_PLACEHOLDERS, type LayoutStep, type PaneLabel, buildLayoutSteps } from "./layout.ts"
import { buildStatusLineCommands } from "./status-line.ts"

const TMUX_SESSION_PREFIX = "kobe-"

export interface MaybeBootstrapResult {
  readonly bootstrapped: boolean
  readonly reason?: string
}

/**
 * If conditions are right, spawn the tmux session, attach, and never
 * return (the process exits with tmux's exit code). Otherwise return
 * an object describing why we fell through so the caller can keep
 * running the in-process TUI path.
 */
export async function maybeBootstrapTmux(): Promise<MaybeBootstrapResult> {
  if (process.env.TMUX) return { bootstrapped: false, reason: "already-in-tmux" }
  if (process.env.KOBE_TMUX === "0") return { bootstrapped: false, reason: "KOBE_TMUX=0" }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { bootstrapped: false, reason: "non-tty" }
  }
  if (!isTmuxAvailable()) {
    process.stderr.write(
      "kobe: tmux not found on PATH; falling back to in-process TUI. Set KOBE_TMUX=0 to silence.\n",
    )
    return { bootstrapped: false, reason: "tmux-missing" }
  }

  const sessionName = generateSessionName()
  const branch = readCurrentBranch()
  const version = pkg.version
  const steps = buildLayoutSteps({ sessionName, placeholders: DEFAULT_PLACEHOLDERS })
  const statusCmds = buildStatusLineCommands(sessionName, { version, branch, pr: "none" })

  const paneIds = new Map<PaneLabel, string>()
  for (const step of steps) {
    runLayoutStep(step, paneIds)
  }
  for (const cmd of statusCmds) {
    const result = nodeSpawnSync("tmux", [...cmd], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    })
    if (result.status !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
      process.stderr.write(`kobe: tmux status command failed: ${cmd.join(" ")}${stderr ? ` (${stderr})` : ""}\n`)
      tryKillSession(sessionName)
      process.exit(1)
    }
  }

  // Install the root-table key chords (M-1..9 switch tab, M-t new-tab,
  // M-w close-tab, M-n/p next/prev task, M-h/j/k/l pane nav). Each is
  // installed via a one-shot `tmux bind-key ...` call; a single
  // failing binding is logged but does NOT abort bootstrap — losing
  // one chord beats refusing to launch the session.
  const kobeBin = process.env.KOBE_BIN && process.env.KOBE_BIN.length > 0 ? process.env.KOBE_BIN : "kobe"
  const bindArgvs = buildBindKeyArgs({ session: sessionName, kobeBin })
  for (const argv of bindArgvs) {
    const result = nodeSpawnSync("tmux", [...argv], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    })
    if (result.status !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
      process.stderr.write(`kobe: tmux bind-key failed: ${argv.join(" ")}${stderr ? ` (${stderr})` : ""}\n`)
    }
  }

  process.stderr.write(`kobe: tmux session ${sessionName} ready (branch=${branch}, version=${version}).\n`)
  process.stderr.write(`kobe: detach with Ctrl-B d; kill with 'tmux kill-session -t ${sessionName}'.\n`)

  // Attach. node:child_process.spawnSync with stdio inherit is closer
  // to a synchronous foreground takeover than Bun.spawn here; Bun's
  // spawn API uses async exit which would race the parent's event
  // loop teardown on Ctrl-B d.
  const attach = nodeSpawnSync("tmux", ["attach-session", "-t", sessionName], { stdio: "inherit" })
  const code = attach.status ?? (attach.signal ? 130 : 0)
  process.exit(code)
}

function runLayoutStep(step: LayoutStep, paneIds: Map<PaneLabel, string>): void {
  if (step.kind === "new-session") {
    const args = [
      "new-session",
      "-d",
      "-s",
      step.sessionName,
      "-n",
      step.windowName,
      "-P",
      "-F",
      "#{pane_id}",
      step.command,
    ]
    const out = runCapturePaneId("tmux", args, step.sessionName)
    paneIds.set(step.name, out)
    return
  }
  if (step.kind === "split") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`kobe.tmux: unknown target pane '${step.targetLabel}' at split`)
    const args = [
      "split-window",
      `-${step.direction}`,
      "-t",
      target,
      "-l",
      step.size,
      "-P",
      "-F",
      "#{pane_id}",
      step.command,
    ]
    const out = runCapturePaneId("tmux", args)
    paneIds.set(step.name, out)
    return
  }
  if (step.kind === "resize") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`kobe.tmux: unknown target pane '${step.targetLabel}' at resize`)
    runOrFail("tmux", ["resize-pane", "-t", target, "-y", String(step.heightRows)])
    return
  }
  if (step.kind === "select") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`kobe.tmux: unknown target pane '${step.targetLabel}' at select`)
    runOrFail("tmux", ["select-pane", "-t", target])
    return
  }
}

function runCapturePaneId(bin: string, args: readonly string[], sessionToCleanup?: string): string {
  const result = nodeSpawnSync(bin, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
    process.stderr.write(`kobe: tmux ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}\n`)
    if (sessionToCleanup) tryKillSession(sessionToCleanup)
    process.exit(1)
  }
  const id = typeof result.stdout === "string" ? result.stdout.trim() : ""
  if (!id.startsWith("%")) {
    process.stderr.write(`kobe: tmux pane-id capture returned unexpected output: ${JSON.stringify(id)}\n`)
    process.exit(1)
  }
  return id
}

function runOrFail(bin: string, args: readonly string[]): void {
  const result = nodeSpawnSync(bin, [...args], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  })
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
    process.stderr.write(`kobe: tmux ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}\n`)
    process.exit(1)
  }
}

function tryKillSession(name: string): void {
  nodeSpawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" })
}

function isTmuxAvailable(): boolean {
  const probe = nodeSpawnSync("tmux", ["-V"], { stdio: "ignore" })
  return probe.status === 0
}

function readCurrentBranch(): string {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : "(detached)"
  } catch {
    return "(no-git)"
  }
}

function generateSessionName(): string {
  const id = Math.random().toString(36).slice(2, 8)
  return `${TMUX_SESSION_PREFIX}${id}`
}
