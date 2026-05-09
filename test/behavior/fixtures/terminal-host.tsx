/**
 * Stream J behavior-test host.
 *
 * Mounts a single `<Terminal>` pane against a fixture cwd (taken from
 * `process.env.KOBE_TERMINAL_CWD`). Used by `terminal.test.ts` to
 * spawn kobe under PTY in "terminal-only" mode so we can drive the
 * pane like a real user would and assert on visible behavior.
 *
 * Why a separate host (not the full app shell):
 *   - The full G2 app (`src/tui/app.tsx`) owns the new-task dialog,
 *     orchestrator wiring, and chat pane. We don't want to test all
 *     of that to verify "terminal echoes hello".
 *   - It also means we don't need a fixture git repo or a fake engine
 *     server — the terminal pane is independent of the orchestrator.
 *   - The host is the same shape as the production component: same
 *     theme provider, same dialog provider (so future Stream-E focus
 *     wiring through dialogs doesn't blow up tests), same registry
 *     model.
 *
 * The driver picks this up via the `KOBE_TERMINAL_HOST=1` env var, set
 * in `cli/index.ts` to branch into `startTerminalHost()` instead of
 * the normal `startTui()` path.
 */

import { render } from "@opentui/solid"
import { ThemeProvider, useTheme } from "../../../src/tui/context/theme"
import { Terminal } from "../../../src/tui/panes/terminal"
import { DialogProvider } from "../../../src/tui/ui/dialog"

const DEFAULT_THEME = "tokyonight"

/**
 * The Stream J behavior test passes both `KOBE_TERMINAL_CWD` and
 * `KOBE_TERMINAL_TASK_ID`. We default the task id to a fixed string
 * so collisions between concurrent test runs are unlikely; the test
 * already isolates via tmpdir cwd.
 */
function readEnv(): { cwd: string; taskId: string } {
  const cwd = process.env.KOBE_TERMINAL_CWD ?? process.cwd()
  const taskId = process.env.KOBE_TERMINAL_TASK_ID ?? `host-${Date.now()}`
  return { cwd, taskId }
}

function HostShell() {
  const { theme } = useTheme()
  const { cwd, taskId } = readEnv()

  // Static accessors — the host doesn't switch tasks, so signals
  // would be over-engineered.
  const cwdAcc = () => cwd
  const taskAcc = () => taskId
  const focusedAcc = () => true

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <text fg={theme.primary}>kobe terminal host</text>
      <Terminal cwd={cwdAcc} taskId={taskAcc} focused={focusedAcc} />
    </box>
  )
}

function HostApp() {
  return (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <DialogProvider>
        <HostShell />
      </DialogProvider>
    </ThemeProvider>
  )
}

/**
 * Entry point: mount the host. `cli/index.ts` calls this when
 * `KOBE_TERMINAL_HOST=1`. We deliberately don't return until the
 * renderer has produced its first frame — render() is awaited inside.
 */
export async function startTerminalHost(): Promise<void> {
  await render(() => <HostApp />)
}
