/**
 * Sprint-8 — opentui Solid host for `kobe pane <name>` subprocesses.
 *
 * Wraps the pane component in ThemeProvider + DialogProvider so any
 * downstream component (notably <FileTree> via FilesPane) finds the
 * contexts it expects. Then mounts via `@opentui/solid` render().
 *
 * Why DialogProvider: <FileTree> imports it transitively even though
 * the subprocess will never pop a dialog. Cheap inclusion vs. risky
 * refactor of the file-tree component.
 *
 * Render options mirror the fallback app: transparent bg, passthrough
 * external output, Ctrl-C off (the tmux pane subprocess shouldn't
 * accidentally tear itself down on a keystroke meant for the chat).
 */

import { render } from "@opentui/solid"
import { ThemeProvider } from "../../context/theme"
import { DialogProvider } from "../../ui/dialog"
import { FilesPane } from "./FilesPane"
import { SidebarPane } from "./SidebarPane"
import { TabStripPane } from "./TabStripPane"
import type { PaneSignals } from "./shared"

const DEFAULT_THEME = "claude"

export type SolidPaneName = "sidebar" | "tab-strip" | "files"

function Host(props: { name: SolidPaneName; signals: PaneSignals }) {
  return (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <DialogProvider>
        {props.name === "sidebar" ? (
          <SidebarPane signals={props.signals} />
        ) : props.name === "tab-strip" ? (
          <TabStripPane signals={props.signals} />
        ) : (
          <FilesPane signals={props.signals} />
        )}
      </DialogProvider>
    </ThemeProvider>
  )
}

/** Mount the Solid pane. Resolves when the renderer is destroyed (e.g.
 * on `daemon.stopping`, or when the tmux pane is killed). */
export async function mountSolidPane(name: SolidPaneName, signals: PaneSignals): Promise<void> {
  await render(() => <Host name={name} signals={signals} />, {
    backgroundColor: "transparent",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
  })
}
