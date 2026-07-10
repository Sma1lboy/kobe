/**
 * Issue mutation side-effects for the Board — save, delete, quick-start, and
 * the optimistic pending-link set that promotes a just-started issue into
 * In progress before the daemon's issue.snapshot confirms the taskId link.
 * Split from Board.tsx so the component keeps only rendering + routing.
 */

import { useEffect, useState } from "react"
import type { RepoIssues } from "./issues.ts"
import {
  deleteIssue,
  type Issue,
  quickStartIssue,
  updateIssue,
} from "./issues.ts"
import { reportError } from "./toast.ts"

export interface IssueActions {
  readonly issueBusy: boolean
  readonly quickStartingId: number | null
  /** `${repo}:${issueId}` → optimistic link, consumed by buildBoardView. */
  readonly pendingLinks: Map<
    string,
    { repo: string; issueId: number; taskId: string }
  >
  saveIssue(
    repo: string,
    id: number,
    patch: { title: string; body: string },
  ): Promise<boolean>
  /** Delete after the caller's confirm dialog. Resolves true when it landed. */
  deleteIssueConfirmed(repo: string, issue: Issue): Promise<boolean>
  /** Spawn a task for the issue; returns its id (caller decides navigation). */
  quickStart(
    repo: string,
    issue: Issue,
    vendor?: string,
    effort?: string,
  ): Promise<string | undefined>
}

export function useIssueActions(args: {
  readonly issueRepos: readonly string[]
  readonly issueData: Record<string, RepoIssues>
  readonly refreshIssues: (repos: readonly string[]) => void
}): IssueActions {
  const { issueRepos, issueData, refreshIssues } = args
  const [issueBusy, setIssueBusy] = useState(false)
  const [quickStartingId, setQuickStartingId] = useState<number | null>(null)
  // Optimistic link: issues whose quickStart has resolved with a taskId but
  // whose issue.snapshot link hasn't landed yet. Promotes them into In
  // progress for one round-trip; cleared once the daemon confirms the link
  // (the issue now carries a real taskId).
  const [pendingLinks, setPendingLinks] = useState<
    Map<string, { repo: string; issueId: number; taskId: string }>
  >(new Map())

  // Drop a pending optimistic-link once the daemon confirms it: the issue now
  // carries a taskId from the snapshot, so the local hint is redundant.
  useEffect(() => {
    setPendingLinks((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      let changed = false
      for (const repo of issueRepos) {
        const state = issueData[repo]
        if (!state || !state.exists) continue
        for (const issue of state.issues) {
          if (issue.taskId && next.delete(`${repo}:${issue.id}`)) changed = true
        }
      }
      return changed ? next : prev
    })
  }, [issueRepos, issueData])

  const saveIssue = async (
    repo: string,
    id: number,
    patch: { title: string; body: string },
  ): Promise<boolean> => {
    setIssueBusy(true)
    try {
      await updateIssue(repo, id, patch)
      // The daemon also pushes issue.snapshot, but its repoRoot aliasing can
      // miss the board's repo key — refresh the GET (which caches under the key
      // the board reads) so the edited title/body lands in the list at once.
      refreshIssues([repo])
      return true
    } catch (err) {
      reportError("update issue", err)
      return false
    } finally {
      setIssueBusy(false)
    }
  }

  // Remove an issue from the daemon-owned tracker after the user confirms.
  // This deletes ONLY the issue record — any task, branch, worktree, or engine
  // session it was linked to is left untouched (the link is one-way).
  const deleteIssueConfirmed = async (
    repo: string,
    issue: Issue,
  ): Promise<boolean> => {
    setIssueBusy(true)
    try {
      await deleteIssue(repo, issue.id)
      refreshIssues([repo])
      return true
    } catch (err) {
      reportError("delete issue", err)
      return false
    } finally {
      setIssueBusy(false)
    }
  }

  // Spawn a task for the issue and RETURN its id so the caller decides whether
  // to watch (open the live session) or stay on the board. The optimistic
  // pending-link still happens here — it's a property of the spawn, not of how
  // the caller reacts.
  const quickStart = async (
    repo: string,
    issue: Issue,
    vendor?: string,
    effort?: string,
  ): Promise<string | undefined> => {
    if (quickStartingId !== null) return undefined
    setQuickStartingId(issue.id)
    try {
      const { taskId } = await quickStartIssue(repo, issue, vendor, effort)
      setPendingLinks((prev) => {
        const next = new Map(prev)
        next.set(`${repo}:${issue.id}`, { repo, issueId: issue.id, taskId })
        return next
      })
      return taskId
    } catch (err) {
      reportError("quick start issue", err)
      return undefined
    } finally {
      setQuickStartingId(null)
    }
  }

  return {
    issueBusy,
    quickStartingId,
    pendingLinks,
    saveIssue,
    deleteIssueConfirmed,
    quickStart,
  }
}
