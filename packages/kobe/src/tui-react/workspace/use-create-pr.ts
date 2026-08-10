/**
 * Create-PR action (FileTree `pr` chip + prefix+p) — a PTY paste+submit of
 * the PR prompt into the selected task's engine session. Split out of
 * `host.tsx` (file-size cap); the identity guard is the same as the other
 * imperative-ref actions there: after an await, the selected task (and the
 * TerminalTabs mount behind the ref) may have changed, and a stale
 * continuation must not deliver into the new task.
 *
 * `createPRAction` is the React-free core (git IO injectable) so vitest can
 * pin the target-branch toast and both identity guards without a repo;
 * `useCreatePR` binds it to the live locale.
 */

import type { MutableRefObject } from "react"
import { buildPRPrompt, gatherPRPromptState } from "../../tui/ops/pr-prompt"
import { useT } from "../i18n"

export type CreatePRDeps = {
  worktree: string | null
  sendToEngineFn: MutableRefObject<((text: string) => void) | null>
  selectedWorktreeRef: { readonly current: string | null }
  notifyError: (message: string) => void
  t: (key: string, params?: Record<string, string | number>) => string
  /** Injectable for tests; default to the real git-backed helpers. */
  gather?: typeof gatherPRPromptState
  build?: typeof buildPRPrompt
}

export function createPRAction(deps: CreatePRDeps): () => Promise<void> {
  const gather = deps.gather ?? gatherPRPromptState
  const build = deps.build ?? buildPRPrompt
  /** On the target branch (a project main session) it toasts instead. */
  return async function createPR(): Promise<void> {
    const wt = deps.worktree
    const send = deps.sendToEngineFn.current
    if (!wt || !send) return
    const state = await gather(wt)
    if (state.branch === state.targetBranch)
      return deps.notifyError(deps.t("files.toast.prOnTargetBranch", { branch: state.branch }))
    const prompt = await build(wt, state)
    if (deps.selectedWorktreeRef.current !== wt || deps.sendToEngineFn.current !== send) return
    send(prompt)
  }
}

export function useCreatePR(args: Omit<CreatePRDeps, "t" | "gather" | "build">): () => Promise<void> {
  const t = useT()
  return createPRAction({ ...args, t })
}
