/**
 * `kobe ops` host — the Ops pane that lives in the right-hand side of
 * the per-task tmux session (v0.6 / KOB-233).
 *
 * v0.6 first shipped a separate `@sma1lboy/kobe-ops` package with a
 * hand-rolled git-status + tree watcher. Jackson's call: reuse the
 * real v0.5 `FileTree` pane instead. It can't live in a separate
 * package (FileTree depends on kobe's theme + keymap contexts, which
 * would create a circular workspace dep), so the Ops pane is a
 * subcommand of the kobe binary — same process entry, full access to
 * the shared UI modules. The tmux pane runs `kobe ops --task-id …
 * --worktree … --target-pane …`; this is a separate OS process from
 * the outer kobe TUI, so it gets its own opentui render loop.
 *
 * Mirrors the v0.5 `KOBE_FILETREE_HOST` behavior-test fixture: mount
 * ThemeProvider + FocusProvider + FileTree full-screen against the
 * task's worktree.
 *
 * Activate (enter / click) on a file injects `@<relpath>` into the
 * claude pane via `tmux send-keys -t <target-pane>` — the file-mention
 * affordance from v0.5, reshaped for the tmux model (KOB-232 tracks
 * the broader Ops-menu work; this is the first slice).
 */

import { render } from "@opentui/solid"
import { FocusProvider } from "../context/focus"
import { ThemeProvider, useTheme } from "../context/theme"
import { addTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { FileTree } from "../panes/filetree"
import { DialogProvider } from "../ui/dialog"

const DEFAULT_THEME = "claude"
const SOCKET = "kobe"

export interface OpsHostArgs {
  readonly taskId: string
  readonly worktree: string
  /** tmux pane id / selector for the claude pane — send-keys target. */
  readonly targetPane: string | null
}

function OpsShell(props: OpsHostArgs) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <FileTree
        worktreePath={() => props.worktree}
        focused={() => true}
        onOpenFile={(rel) => {
          void mentionFileInClaude(props.targetPane, rel)
        }}
      />
    </box>
  )
}

function OpsApp(props: OpsHostArgs) {
  return (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <FocusProvider initial="files">
        <DialogProvider>
          <OpsShell {...props} />
        </DialogProvider>
      </FocusProvider>
    </ThemeProvider>
  )
}

/**
 * Inject `@<relPath> ` into the claude pane. No-op when we don't have
 * a target pane (the launcher always passes one; the guard is for the
 * standalone `kobe ops` invocation a user might run by hand). Uses the
 * same `-L kobe` socket the launcher created the session on.
 */
async function mentionFileInClaude(targetPane: string | null, relPath: string): Promise<void> {
  if (!targetPane) return
  try {
    await Bun.spawn(["tmux", "-L", SOCKET, "send-keys", "-t", targetPane, `@${relPath} `], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).exited
  } catch {
    // best-effort — a failed mention shouldn't crash the Ops pane
  }
}

/**
 * Entry point for `kobe ops`. Registers user themes (so the Ops pane
 * matches the outer TUI's theme choice) then mounts the FileTree
 * full-screen.
 */
export async function startOpsHost(args: OpsHostArgs): Promise<void> {
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  await render(() => <OpsApp {...args} />, {
    backgroundColor: "transparent",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    useKittyKeyboard: {},
  })
}
