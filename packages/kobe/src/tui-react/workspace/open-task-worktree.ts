import { existsSync } from "node:fs"
import { detectWorktreeOpener, openWorktree } from "../../tui/lib/worktree-opener"

type OpenTaskWorktreeDeps = {
  taskPath?: string
  ensureWorktree: (id: string) => Promise<string>
  notifyError: (message: string) => void
  noEditorMessage: string
  openFailedMessage: (label: string) => string
}

/** Ensure a task worktree exists, then open it with the detected editor. */
export async function requestTaskWorktreeOpen(id: string, deps: OpenTaskWorktreeDeps): Promise<void> {
  let path = deps.taskPath
  if (!path || !existsSync(path)) {
    try {
      path = await deps.ensureWorktree(id)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      deps.notifyError(`Couldn't create worktree: ${reason}`)
      return
    }
  }
  if (!path || !existsSync(path)) return

  const opener = detectWorktreeOpener()
  if (!opener) {
    deps.notifyError(deps.noEditorMessage)
    return
  }
  if (!openWorktree(path, opener)) {
    deps.notifyError(deps.openFailedMessage(opener.label))
  }
}
