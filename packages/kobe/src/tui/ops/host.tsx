/**
 * `kobe ops` host — the Ops pane on the right side of a task's tmux
 * session (v0.6 / KOB-233).
 *
 * Reuses the v0.5 `FileTree` to browse the worktree. Activating a file
 * (enter / click) opens a **full-width preview window** — a fresh tmux
 * window running the user's diff/pager tooling (`git diff | delta`, or
 * `bat`/`less` for unchanged files). Reviewing a diff wants the whole
 * terminal width, which the narrow Ops pane can't give; a new window
 * does, and `q` in the pager closes it back to the three-pane layout.
 * We deliberately do NOT render a file viewer inside this pane —
 * shelling out to the user's tools is simpler and reviews better.
 *
 * `m` injects `@<path>` into the claude pane via `tmux send-keys`.
 *
 * Runs in its own OS process inside the tmux pane (separate opentui
 * render loop from the outer kobe TUI). It can't share the outer TUI's
 * Solid runtime, but it DOES inherit the user's theme via
 * `readPersistedUiPrefs` (read-only — the outer app owns `state.json`).
 */

import { newWindow, tmuxSessionName } from "@/tmux/client"
import { previewWindowCommand } from "@/tmux/session-layout"
import { render } from "@opentui/solid"
import { onMount } from "solid-js"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { type PersistedUiPrefs, readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { FileTree } from "../panes/filetree"
import { DialogProvider } from "../ui/dialog"

const FALLBACK_THEME = "claude"

export interface OpsHostArgs {
  readonly taskId: string
  readonly worktree: string
  /** tmux pane id / selector for the claude pane — send-keys target. */
  readonly targetPane: string | null
}

type ThemePrefs = PersistedUiPrefs

function OpsShell(props: OpsHostArgs & { prefs: ThemePrefs }) {
  const themeCtx = useTheme()
  const { theme } = themeCtx

  // Apply the inherited transparent-bg + focus-accent prefs once the
  // theme context is live (active theme name comes from the
  // ThemeProvider's initial prop, so no flash).
  onMount(() => {
    themeCtx.setTransparentBackground(props.prefs.transparent)
    if (props.prefs.focusAccent) themeCtx.setFocusAccent(props.prefs.focusAccent)
  })

  // Open the file's diff/content in a full-width preview window of the
  // task's tmux session. The Ops pane lives in that session, named
  // `kobe-<taskId>`, so we can target it by name.
  function openPreview(rel: string): void {
    void newWindow(tmuxSessionName(props.taskId), {
      cwd: props.worktree,
      command: previewWindowCommand(props.worktree, rel),
      name: basename(rel),
    })
  }

  // `targetPane` (the claude pane id) is reserved for the `@file`
  // mention injection KOB-232 will wire; unused in this slice.
  void props.targetPane

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <FileTree worktreePath={() => props.worktree} focused={() => true} onOpenFile={openPreview} />
    </box>
  )
}

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

function OpsApp(props: OpsHostArgs & { prefs: ThemePrefs }) {
  return (
    <ThemeProvider mode="dark" theme={props.prefs.theme}>
      <DialogProvider>
        <OpsShell {...props} />
      </DialogProvider>
    </ThemeProvider>
  )
}

export async function startOpsHost(args: OpsHostArgs): Promise<void> {
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  const prefs = readPersistedUiPrefs(FALLBACK_THEME)
  await render(() => <OpsApp {...args} prefs={prefs} />, {
    backgroundColor: "transparent",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    useKittyKeyboard: {},
  })
}
