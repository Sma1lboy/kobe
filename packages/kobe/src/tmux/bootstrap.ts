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
import { connectOrStartDaemon } from "../client/daemon-process.ts"
import { buildBindKeyArgs } from "./keybindings.ts"
import {
  DEFAULT_PLACEHOLDERS,
  type LayoutStep,
  type PaneLabel,
  buildLayoutSteps,
  panePaneCommand,
  placeholderShellCommand,
  shellPaneCommand,
} from "./layout.ts"
import { buildPaneStyleCommands } from "./pane-style.ts"
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
    process.stderr.write("kobe: tmux not found on PATH; falling back to in-process TUI. Set KOBE_TMUX=0 to silence.\n")
    return { bootstrapped: false, reason: "tmux-missing" }
  }

  const sessionName = generateSessionName()
  const branch = readCurrentBranch()
  const version = pkg.version
  // Sprint-4: sidebar / tab-strip / files panes run `kobe pane <name>`
  // subprocesses that subscribe to the daemon and render task state.
  // Shell becomes a real interactive shell. Chat stays on the
  // `tail -f` placeholder until the engine subprocess wires in
  // (sprint-5).
  const kobeBin = process.env.KOBE_BIN && process.env.KOBE_BIN.length > 0 ? process.env.KOBE_BIN : "kobe"
  const steps = buildLayoutSteps({
    sessionName,
    placeholders: DEFAULT_PLACEHOLDERS,
    paneCommands: {
      sidebar: panePaneCommand("sidebar", kobeBin),
      tabStrip: panePaneCommand("tab-strip", kobeBin),
      files: panePaneCommand("files", kobeBin),
      shell: shellPaneCommand(process.env.SHELL),
    },
  })
  const statusCmds = buildStatusLineCommands(sessionName, { version, branch, pr: "none" })
  const paneStyleCmds = buildPaneStyleCommands(sessionName)

  const paneIds = new Map<PaneLabel, string>()
  for (const step of steps) {
    runLayoutStep(step, paneIds, sessionName)
  }
  for (const cmd of [...statusCmds, ...paneStyleCmds]) {
    const result = nodeSpawnSync("tmux", [...cmd], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    })
    if (result.status !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
      process.stderr.write(`kobe: tmux style command failed: ${cmd.join(" ")}${stderr ? ` (${stderr})` : ""}\n`)
      tryKillSession(sessionName)
      process.exit(1)
    }
  }

  // Install the root-table key chords (M-1..9 switch tab, M-t new-tab,
  // M-w close-tab, M-n/p next/prev task, M-h/j/k/l pane nav). Each is
  // installed via a one-shot `tmux bind-key ...` call; a single
  // failing binding is logged but does NOT abort bootstrap — losing
  // one chord beats refusing to launch the session.
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

  // Sprint-6 (KOB-218): create the hidden stash window + tell the daemon
  // about (session, stash window, chat slot id, saved layout) so future
  // rpc.* verbs can swap per-(task,tab) claude panes into the chat slot.
  // Failures degrade gracefully — without `tmux.attach`, the chat slot
  // keeps its placeholder and the rpc.* verbs become no-ops, but the rest
  // of the TUI still works.
  const chatSlotPaneId = paneIds.get("chat")
  if (chatSlotPaneId) {
    await attachDaemonToTmux(sessionName, chatSlotPaneId, kobeBin)
  } else {
    process.stderr.write("kobe: tmux bootstrap missing chat pane id; daemon swap disabled\n")
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

/**
 * Bring up the stash window, snapshot the saved layout, then connect to
 * (or start) the daemon and fire `tmux.attach`. All failures are caught
 * and logged — losing the daemon swap is a degraded mode (chat slot
 * keeps its placeholder), not a fatal bootstrap error.
 */
async function attachDaemonToTmux(sessionName: string, chatSlotPaneId: string, kobeBin: string): Promise<void> {
  let stashWindow = ""
  let savedLayout = ""
  try {
    // 1. Hidden stash window. One placeholder pane to begin with — the
    //    adapter will `split-window` into this window to spawn per-tab
    //    claude panes. `-d` keeps it detached so we don't lose focus on
    //    the main `kobe` window.
    stashWindow = `${sessionName}:stash`
    const newWindowResult = nodeSpawnSync(
      "tmux",
      ["new-window", "-d", "-t", sessionName, "-n", "stash", placeholderShellCommand("stash-init")],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    )
    if (newWindowResult.status !== 0) {
      const stderr = typeof newWindowResult.stderr === "string" ? newWindowResult.stderr.trim() : ""
      process.stderr.write(`kobe: tmux new-window stash failed${stderr ? `: ${stderr}` : ""}\n`)
      return
    }

    // 2. Snapshot the visible layout BEFORE any swap. `swap-pane` can
    //    drift sibling pane sizes; the daemon adapter restores this
    //    string via `select-layout` after every swap.
    const layoutResult = nodeSpawnSync(
      "tmux",
      ["display-message", "-p", "-t", `${sessionName}:kobe`, "#{window_visible_layout}"],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    )
    if (layoutResult.status !== 0) {
      const stderr = typeof layoutResult.stderr === "string" ? layoutResult.stderr.trim() : ""
      process.stderr.write(`kobe: tmux display-message saved layout failed${stderr ? `: ${stderr}` : ""}\n`)
      return
    }
    savedLayout = typeof layoutResult.stdout === "string" ? layoutResult.stdout.trim() : ""
    if (!savedLayout) {
      process.stderr.write("kobe: empty saved layout; daemon swap disabled\n")
      return
    }
  } catch (err) {
    process.stderr.write(`kobe: tmux stash setup threw ${describeErr(err)}; daemon swap disabled\n`)
    return
  }

  // 3. Spawn (or connect) the daemon and hand it the wiring. The 5s
  //    timeout inside connectOrStartDaemon means a daemon startup
  //    failure surfaces here as a rejection rather than hanging
  //    bootstrap forever.
  try {
    const client = await connectOrStartDaemon()
    try {
      await client.request("tmux.attach", {
        session: sessionName,
        stashWindow,
        chatSlotPaneId,
        savedLayout,
        kobeBin,
      })
    } finally {
      client.close()
    }
  } catch (err) {
    process.stderr.write(`kobe: tmux.attach to daemon failed ${describeErr(err)}; degraded mode\n`)
  }
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return `(${err.message})`
  return `(${String(err)})`
}

function runLayoutStep(step: LayoutStep, paneIds: Map<PaneLabel, string>, sessionName?: string): void {
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
      ...(step.before ? ["-b"] : []),
      "-t",
      target,
      "-l",
      step.size,
      "-P",
      "-F",
      "#{pane_id}",
      step.command,
    ]
    const out = runCapturePaneId("tmux", args, sessionName)
    paneIds.set(step.name, out)
    return
  }
  if (step.kind === "resize") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`kobe.tmux: unknown target pane '${step.targetLabel}' at resize`)
    runOrFail("tmux", ["resize-pane", "-t", target, "-y", String(step.heightRows)], sessionName)
    return
  }
  if (step.kind === "select") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`kobe.tmux: unknown target pane '${step.targetLabel}' at select`)
    runOrFail("tmux", ["select-pane", "-t", target], sessionName)
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

function runOrFail(bin: string, args: readonly string[], sessionToCleanup?: string): void {
  const result = nodeSpawnSync(bin, [...args], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  })
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
    process.stderr.write(`kobe: tmux ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}\n`)
    if (sessionToCleanup) tryKillSession(sessionToCleanup)
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
