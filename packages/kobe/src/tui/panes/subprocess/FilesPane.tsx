/**
 * Sprint-8 — files pane subprocess (Solid render).
 *
 * Thin wrapper that reuses the existing <FileTree> component. The
 * subprocess can't pop a preview tab (that's an in-app dialog), so
 * `onOpenFile` is a no-op here. Worktree path is derived reactively
 * from the active task in the shared pane signals.
 */

import { createMemo } from "solid-js"
import { FileTree } from "../filetree"
import type { PaneSignals } from "./shared"

export function FilesPane(props: { signals: PaneSignals }) {
  const worktreePath = createMemo<string | null>(() => {
    const active = props.signals.activeTask()
    return active ? active.worktreePath : null
  })
  return <FileTree worktreePath={worktreePath} onOpenFile={() => undefined} />
}
