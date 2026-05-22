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
import { type Accessor, type JSXElement, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"

export type FullscreenRunOpts = {
  /** The opentui renderer to suspend/resume around the handover. */
  renderer: CliRenderer
  /** Working directory for the child (the task's worktree). */
  cwd: string
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
  /** Worktree the claude session runs in. Null = no task selected. */
  cwd: Accessor<string | null>
  /** argv to hand off to (the chat pane passes `["claude"]`). */
  command: readonly string[]
  /** Whether the workspace pane currently owns focus (gates the chord). */
  focused: Accessor<boolean>
}

/**
 * Launcher view for the chat pane's interactive-claude mode. `⏎` while
 * the pane is focused hands the terminal to claude full-screen; when
 * claude exits the user lands back here.
 */
export function ClaudeLauncher(props: ClaudeLauncherProps): JSXElement {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [running, setRunning] = createSignal(false)

  const enter = (): void => {
    const cwd = props.cwd()
    if (!cwd || running()) return
    setRunning(true)
    void runFullscreen({ renderer, cwd, command: props.command }).finally(() => setRunning(false))
  }

  useBindings(() => ({
    enabled: props.focused() && !running() && props.cwd() !== null,
    bindings: [
      { key: "return", cmd: enter },
      { key: "enter", cmd: enter },
    ],
  }))

  return (
    <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
      <text fg={theme.text}>Claude session</text>
      <text fg={theme.textMuted}>{props.cwd() ? "press ⏎ to enter — full screen" : "(no task selected)"}</text>
      <text fg={theme.textMuted}>exit claude (ctrl+c / /exit) to come back</text>
    </box>
  )
}
