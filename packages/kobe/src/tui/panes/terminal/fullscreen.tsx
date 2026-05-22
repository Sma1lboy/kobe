/**
 * Full-terminal handover for interactive engines (KOB-225).
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
 * `ClaudeLauncher` is the in-pane entry point: it replaces the laggy
 * embedded `<Terminal>` in the chat content pane's interactive mode
 * with a "press ⏎ to enter" prompt, and runs the handover on submit.
 */

import type { CliRenderer } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { type Accessor, type JSXElement, Show, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { attachArgv, ensureSession, tmuxAvailable, tmuxSessionName } from "./tmux"

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
 * Suspend the renderer, run `command` with the real TTY inherited, then
 * resume. Resolves with the child's exit code. Always resumes — even if
 * the spawn throws — so a failed launch never leaves kobe's UI dark.
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

export type ClaudeLauncherProps = {
  /** Stable task id — keys the persistent tmux session. Null = no task. */
  taskId: Accessor<string | null>
  /** Worktree the claude session runs in. Null = no task selected. */
  cwd: Accessor<string | null>
  /** argv the tmux session runs (the chat pane passes `["claude"]`). */
  command: readonly string[]
  /** Whether the workspace pane currently owns focus (gates the chord). */
  focused: Accessor<boolean>
}

/**
 * Launcher view for the chat pane's interactive-claude mode. `⏎` while
 * the pane is focused attaches the terminal to the task's tmux session
 * full-screen (creating it on first enter); the session persists across
 * detach (Ctrl+Q / Ctrl+B D) and kobe restarts. When the user detaches
 * or claude exits they land back here.
 */
export function ClaudeLauncher(props: ClaudeLauncherProps): JSXElement {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [running, setRunning] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const enter = (): void => {
    const taskId = props.taskId()
    const cwd = props.cwd()
    if (!taskId || !cwd || running()) return
    setRunning(true)
    setError(null)
    void (async () => {
      if (!(await tmuxAvailable())) {
        setError("tmux not found on PATH — install tmux to use interactive mode")
        return
      }
      const name = tmuxSessionName(taskId)
      await ensureSession({ name, cwd, command: props.command })
      await runFullscreen({ renderer, command: attachArgv(name) })
    })()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRunning(false))
  }

  useBindings(() => ({
    enabled: props.focused() && !running() && props.taskId() !== null,
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
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}
