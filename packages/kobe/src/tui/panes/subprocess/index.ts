/**
 * Sprint-8 — barrel for the `kobe pane <name>` Solid subprocesses.
 * Imported by `src/cli/pane.ts` to mount each pane's Solid app.
 */

export { FilesPane } from "./FilesPane"
export { SidebarPane } from "./SidebarPane"
export { TabStripPane } from "./TabStripPane"
export { type PaneSignals, type PaneSubprocessClient, createPaneSignals, subscribePaneSignals } from "./shared"
