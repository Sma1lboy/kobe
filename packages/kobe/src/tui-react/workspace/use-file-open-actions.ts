/**
 * The two FileTree "open this file" actions the workspace host hands down:
 * Enter (editor / plugin / OS opener) and `d` (read-only diff tab).
 *
 * Both reach the live TerminalTabs mount through imperative refs the host
 * owns, so they take those refs rather than closing over host state — the
 * mount is re-handed on every task/worktree switch.
 */

import { join } from "node:path"
import type { RefObject } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { resolveEditorLaunch } from "../../tui/lib/editor-launch.ts"
import { pathLeaf } from "../../tui/lib/path-helpers"
import { openExternally } from "../../tui/panes/filetree/open-external"
import type { FocusContextValue } from "../context/focus"
import { tryPluginFileOpen } from "./plugin-file-open"

export type FileOpenActions = {
  /** FileTree's Enter: plugin handlers, else the editor tab, else the OS. */
  openFileInEditor: (relPath: string) => Promise<void>
  /** FileTree's `d`: a read-only diff in the workspace content tab. */
  openDiff: (relPath: string, base?: string) => void
}

export function useFileOpenActions(deps: {
  orch: RemoteOrchestrator
  worktree: string | null
  selectedId: string | null
  focus: FocusContextValue
  openEditorTabFn: RefObject<((command: readonly string[], label: string) => void) | null>
  openDiffTabFn: RefObject<((relPath: string, label: string, base?: string) => void) | null>
  selectedWorktreeRef: RefObject<string | null>
}): FileOpenActions {
  const { orch, worktree, selectedId, focus, openEditorTabFn, openDiffTabFn, selectedWorktreeRef } = deps

  async function openFileInEditor(relPath: string): Promise<void> {
    const wt = worktree
    if (!wt) return
    const abs = join(wt, relPath)
    orch.reportUiEvent("file.will-open", selectedId ?? undefined, { path: abs })
    const opened = (via: string) => orch.reportUiEvent("file.opened", selectedId ?? undefined, { path: abs, via })
    // Plugin file handlers outrank the editor (docs/design/plugins.md).
    if (tryPluginFileOpen(abs)) return opened("plugin")
    const openEditorTab = openEditorTabFn.current
    const launch = openEditorTab ? await resolveEditorLaunch(wt, abs) : null
    if (!launch) {
      openExternally(abs)
      return opened("external")
    }
    // Stale continuation: the user switched tasks while the editor resolved —
    // the file belongs to the old worktree, not whatever tab mount is live now.
    if (selectedWorktreeRef.current !== wt || openEditorTabFn.current !== openEditorTab) return
    openEditorTab?.(["sh", "-c", launch.command], launch.label)
    opened("editor")
    focus.setFocused("workspace")
  }

  // Deliberately NO `focus.setFocused` — a read-only open is a content swap,
  // not a navigation (KOB-25), so the FileTree keeps keyboard focus.
  function openDiff(relPath: string, base?: string): void {
    const label = pathLeaf(relPath)
    openDiffTabFn.current?.(relPath, label, base)
  }

  return { openFileInEditor, openDiff }
}
