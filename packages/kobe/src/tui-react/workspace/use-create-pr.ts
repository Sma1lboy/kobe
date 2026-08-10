/**
 * Create-PR action (FileTree `pr` chip + prefix+p) — a PTY paste+submit of
 * the PR prompt into the selected task's engine session. Split out of
 * `host.tsx` (file-size cap); the identity guard is the same as the other
 * imperative-ref actions there: after an await, the selected task (and the
 * TerminalTabs mount behind the ref) may have changed, and a stale
 * continuation must not deliver into the new task.
 */

import type { MutableRefObject } from "react"
import { buildPRPrompt, gatherPRPromptState } from "../../tui/ops/pr-prompt"
import { useT } from "../i18n"

export function useCreatePR(args: {
  worktree: string | null
  sendToEngineFn: MutableRefObject<((text: string) => void) | null>
  selectedWorktreeRef: { readonly current: string | null }
  notifyError: (message: string) => void
}): () => Promise<void> {
  const t = useT()
  /** On the target branch (a project main session) it toasts instead. */
  return async function createPR(): Promise<void> {
    const wt = args.worktree
    const send = args.sendToEngineFn.current
    if (!wt || !send) return
    const state = await gatherPRPromptState(wt)
    if (state.branch === state.targetBranch)
      return args.notifyError(t("files.toast.prOnTargetBranch", { branch: state.branch }))
    const prompt = await buildPRPrompt(wt, state)
    if (args.selectedWorktreeRef.current !== wt || args.sendToEngineFn.current !== send) return
    send(prompt)
  }
}
