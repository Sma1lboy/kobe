/**
 * Full-terminal handover for interactive engines (v0.6).
 *
 * The embedded-terminal model (xterm emulation + per-frame opentui
 * recomposite) can't keep up with a heavy-redraw TUI like interactive
 * `claude` — every spinner tick / synchronized-output block forced a
 * full-screen snapshot + repaint, which felt laggy. agent-deck solves
 * the same problem with `tea.Exec()`: the outer manager TUI hands the
 * real terminal to the child, which then draws at native speed, and
 * takes it back when the child exits.
 *
 * `runFullscreen` is that primitive for kobe: suspend the opentui
 * renderer (which drops mouse/raw-mode/input and releases the TTY),
 * spawn the child with inherited stdio so it owns the real terminal,
 * await its exit, then resume + repaint. No PTY, no emulator, no
 * compositing while the child is in front.
 *
 * `ClaudeLauncher` is the in-pane entry point: a "press ⏎ to enter"
 * splash that, on submit, ensures the task's worktree exists, then
 * attaches to the task's persistent tmux session (creating it on
 * first enter). Step B (KOB-228) extends `ensureSession` to pre-split
 * the session into three panes (claude / Ops / shell).
 */

import type { CliRenderer } from "@opentui/core"
import { type Accessor, type JSXElement, Show } from "solid-js"
import { resolveRepoInit } from "../../../state/repo-init.ts"
import type { VendorId } from "../../../types/task.ts"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { useDialog } from "../../ui/dialog"
import { attachArgv, ensureSession, sessionExists, tmuxAvailable, tmuxSessionName } from "./tmux"

export type FullscreenRunOpts = {
  /** The opentui renderer to suspend/resume around the handover. */
  renderer: CliRenderer
  /** Working directory for the child. Omit to inherit kobe's cwd. */
  cwd?: string
  /** argv to run, e.g. `["claude"]`. First element is the executable. */
  command: readonly string[]
  /** Extra env merged over `process.env`. */
  env?: Record<string, string | undefined>
}

/**
 * Suspend the renderer, run `command` with the real TTY inherited,
 * then resume. Resolves with the child's exit code. Always resumes —
 * even if the spawn throws — so a failed launch never leaves kobe's
 * UI dark.
 */
export async function runFullscreen(opts: FullscreenRunOpts): Promise<number | null> {
  const { renderer, cwd, command } = opts
  if (command.length === 0) return null
  renderer.suspend()
  try {
    const proc = Bun.spawn(command as string[], {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, ...opts.env },
    })
    return await proc.exited
  } catch {
    return null
  } finally {
    renderer.resume()
  }
}

export type LaunchTaskTmuxOpts = {
  /** opentui renderer — suspend/resume around the handover. */
  renderer: CliRenderer
  /** Stable task id — keys the persistent tmux session. */
  taskId: string
  /** Worktree the session runs in. Empty triggers `onEnsureWorktree`. */
  cwd: string | null
  /** argv for pane 0 (the engine pane). */
  command: readonly string[]
  /** Engine vendor — tagged on the session so `new-chattab` relaunches the same engine. */
  vendor?: VendorId
  /** Repo root (git toplevel) — for per-repo init script/prompt resolution. */
  repo?: string
  /** Materialise the worktree on first enter. */
  onEnsureWorktree: (taskId: string) => Promise<string>
}

export type LaunchTaskTmuxResult = { kind: "ok"; exitCode: number | null } | { kind: "error"; message: string }

/**
 * Lift the launcher's "ensure tmux available + worktree allocated +
 * session created + attach" sequence so it can be triggered from
 * outside the {@link ClaudeLauncher} component too (the sidebar fires
 * it from Enter via `onActivate`, app.tsx wires both paths). Errors
 * are returned, not thrown, so the caller decides whether to log /
 * surface them.
 */
export async function launchTaskTmux(opts: LaunchTaskTmuxOpts): Promise<LaunchTaskTmuxResult> {
  if (!(await tmuxAvailable())) {
    return { kind: "error", message: "tmux not found on PATH — install tmux to use interactive mode" }
  }
  let cwd = opts.cwd
  if (!cwd) {
    try {
      cwd = await opts.onEnsureWorktree(opts.taskId)
    } catch (err) {
      return {
        kind: "error",
        message: `worktree allocation failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  const name = tmuxSessionName(opts.taskId)
  const init = opts.repo ? resolveRepoInit(opts.repo, cwd) : {}
  const ready = await ensureSession({
    name,
    cwd,
    command: opts.command,
    taskId: opts.taskId,
    vendor: opts.vendor,
    initScript: init.initScript,
    initPrompt: init.initPrompt,
  })
  if (!ready) {
    // ensureSession failed to create the session (e.g. `tmux new-session`
    // returned no pane id). Don't attach to a session that isn't there —
    // surface it instead of bouncing the user silently to the splash.
    return { kind: "error", message: `tmux session ${name} failed to start (check the console / daemon log)` }
  }
  const exitCode = await runFullscreen({ renderer: opts.renderer, command: attachArgv(name) })
  // A clean detach (Ctrl+Q / Ctrl+B d) exits 0 and leaves the session
  // alive. `null` means the attach process couldn't even spawn, and a
  // nonzero exit with the session GONE means the attach failed (the
  // session died between build and attach) — both are real errors, not
  // a clean detach, so surface them rather than silently re-showing the
  // splash (KOB-244).
  if (exitCode === null) {
    return { kind: "error", message: `failed to attach to tmux session ${name}` }
  }
  if (exitCode !== 0 && !(await sessionExists(name))) {
    return { kind: "error", message: `tmux session ${name} ended unexpectedly (attach exited ${exitCode})` }
  }
  return { kind: "ok", exitCode }
}

export type ClaudeLauncherProps = {
  /** Stable task id — keys the persistent tmux session. Null = no task. */
  taskId: Accessor<string | null>
  /** Whether the workspace pane currently owns focus (gates the chord). */
  focused: Accessor<boolean>
  /**
   * Run the full enter sequence for `taskId`. The HOST owns this so both
   * entry points (sidebar Enter and this launcher's own Enter) converge
   * on one code path — launch + auto-title + error surfacing all happen
   * once, regardless of which pane was focused (KOB-244). The launcher
   * never calls `launchTaskTmux` directly anymore.
   */
  onEnter: (taskId: string) => void
  /** Host-owned: an enter is in flight (gates the chord + dims the splash). */
  running: Accessor<boolean>
  /** Host-owned: last launch error to display (`null` = none). */
  error: Accessor<string | null>
}

/**
 * Launcher view for the workspace pane. `⏎` while the pane is focused
 * runs the host's enter sequence, which attaches the terminal to the
 * task's tmux session full-screen (creating it on first enter); the
 * session persists across detach (Ctrl+Q / Ctrl+B D) and kobe restarts.
 * When the user detaches or claude exits they land back here.
 */
export function ClaudeLauncher(props: ClaudeLauncherProps): JSXElement {
  const { theme } = useTheme()
  const dialog = useDialog()

  const enter = (): void => {
    const taskId = props.taskId()
    if (!taskId || props.running()) return
    props.onEnter(taskId)
  }

  useBindings(() => ({
    // Gate on an empty dialog stack too: an Enter submitting a dialog
    // (e.g. settings' command editor opened over the workspace) must not
    // fall through the keymap to here and launch the task (KOB-244).
    enabled: props.focused() && !props.running() && props.taskId() !== null && dialog.stack.length === 0,
    bindings: [
      { key: "return", cmd: enter },
      { key: "enter", cmd: enter },
    ],
  }))

  return (
    <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
      <text fg={theme.text}>Claude session</text>
      <text fg={theme.textMuted}>{props.taskId() ? "press ⏎ to enter — full screen" : "(no task selected)"}</text>
      <text fg={theme.textMuted}>ctrl+q (or ctrl+b d) detaches — the session keeps running</text>
      <Show when={props.error()}>
        <text fg={theme.error}>{props.error()}</text>
      </Show>
    </box>
  )
}
