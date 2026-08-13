/**
 * WorktreesPage — the standalone `/worktrees` lens onto every git worktree
 * kobe can see across all locally-saved projects (not just kobe-managed
 * ones — see `web-worktrees-route.ts`'s `GitWorktreeManager.listAll`). Lets
 * Jackson audit and clean up stray worktrees from one page instead of
 * `cd`-ing into each project.
 *
 * Delete flow mirrors the daemon's own safety gate: a clean worktree deletes
 * on a single confirm; a dirty one (uncommitted/untracked changes) fails the
 * first attempt and surfaces a SECOND, danger-styled confirm before retrying
 * with `force: true` — no client-side dirty check duplicates the backend's.
 *
 * The delete itself is OPTIMISTIC: `git worktree remove` on a worktree with a
 * populated `node_modules` is seconds of real filesystem work, so the row and
 * the dialog go away the moment the user confirms and the request runs in the
 * background. A failure puts the row back. Same contract as the TUI page
 * (`kobe/src/tui-react/component/worktrees-page.tsx`).
 */

import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, RefreshCw } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useAppState } from "../lib/store.ts"
import { relativeTimeAgo } from "../lib/time.ts"
import { reportError } from "../lib/toast.ts"
import {
  DirtyWorktreeError,
  fetchWorktreeProjects,
  removeWorktree,
  type WorktreeProject,
  type WorktreeRow,
} from "../lib/worktrees.ts"
import { ConfirmDialog } from "./ConfirmDialog.tsx"
import { DesktopWindowControls } from "./DesktopWindowControls.tsx"

function remoteBadge(status: boolean | null) {
  if (status === true) {
    return (
      <span className="shrink-0 text-[10px] text-kobe-green">on remote</span>
    )
  }
  if (status === false) {
    return (
      <span className="shrink-0 text-[10px] text-kobe-yellow">not pushed</span>
    )
  }
  return (
    <span className="shrink-0 text-[10px] text-subtle">remote unknown</span>
  )
}

function WorktreeRowView({
  row,
  linkedTaskTitle,
  onDelete,
}: {
  row: WorktreeRow
  linkedTaskTitle: string | null
  onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-b border-line-subtle px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[12px] text-fg">
            {row.branch || "(detached)"}
          </span>
          {row.kobeManaged && (
            <span className="shrink-0 text-[10px] text-subtle">rove</span>
          )}
          {row.dirty && (
            <span className="shrink-0 text-[10px] text-kobe-yellow">dirty</span>
          )}
          {remoteBadge(row.branchOnRemote)}
          {linkedTaskTitle && (
            <span className="shrink-0 truncate text-[10px] text-subtle">
              task: {linkedTaskTitle}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-subtle">
          <span className="truncate font-mono">{row.path}</span>
          {row.createdAtMs > 0 && (
            <span className="ml-auto shrink-0">
              created {relativeTimeAgo(row.createdAtMs)}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onDelete}
        className="shrink-0 border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-kobe-red hover:text-kobe-red"
      >
        Delete
      </button>
    </div>
  )
}

export function WorktreesPage() {
  const navigate = useNavigate()
  const { tasks } = useAppState()
  const [projects, setProjects] = useState<WorktreeProject[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<WorktreeRow | null>(null)
  const [pendingForceDelete, setPendingForceDelete] =
    useState<WorktreeRow | null>(null)
  // Paths whose delete is in flight — hidden from the list so the row goes
  // away on confirm, restored if the request fails.
  const [removingPaths, setRemovingPaths] = useState<readonly string[]>([])

  const linkedTaskTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const task of tasks) {
      if (task.worktreePath)
        map.set(task.worktreePath, task.title || task.branch)
    }
    return map
  }, [tasks])

  const load = (): void => {
    setLoading(true)
    void fetchWorktreeProjects()
      .then(setProjects)
      .catch((err: unknown) => reportError("load worktrees", err))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const visibleProjects = (projects ?? []).map((project) => ({
    ...project,
    worktrees: project.worktrees.filter((w) => !removingPaths.includes(w.path)),
  }))

  const removeRow = (path: string): void => {
    setProjects(
      (prev) =>
        prev?.map((project) => ({
          ...project,
          worktrees: project.worktrees.filter((w) => w.path !== path),
        })) ?? prev,
    )
  }

  /** Hide the row, run the delete in the background, restore it on failure. */
  const deleteInBackground = (row: WorktreeRow, force: boolean): void => {
    setRemovingPaths((paths) => [...paths, row.path])
    void removeWorktree(row.path, force)
      .then(() => {
        // Drop the row for real, then stop tracking it as "removing".
        removeRow(row.path)
        setRemovingPaths((paths) => paths.filter((p) => p !== row.path))
      })
      .catch((err: unknown) => {
        setRemovingPaths((paths) => paths.filter((p) => p !== row.path))
        if (!force && err instanceof DirtyWorktreeError) {
          setPendingForceDelete(row)
        } else {
          reportError(force ? "force delete worktree" : "delete worktree", err)
        }
      })
  }

  const onConfirmDelete = (): void => {
    if (!pendingDelete) return
    const row = pendingDelete
    setPendingDelete(null)
    deleteInBackground(row, false)
  }

  const onConfirmForceDelete = (): void => {
    if (!pendingForceDelete) return
    const row = pendingForceDelete
    setPendingForceDelete(null)
    deleteInBackground(row, true)
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <header
        data-kobe-topbar
        className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-3"
      >
        <DesktopWindowControls />
        <button
          type="button"
          onClick={() => navigate({ to: "/" })}
          className="flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
          title="Back to workspace"
        >
          <ArrowLeft size={15} strokeWidth={1.8} />
          <span className="text-[12px]">Workspace</span>
        </button>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
          Worktrees
        </span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 text-muted transition-colors hover:text-fg disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw
            size={13}
            strokeWidth={1.8}
            className={loading ? "animate-spin" : ""}
          />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {projects === null ? (
          <p className="px-3 py-6 text-center text-[12px] text-subtle">
            Loading worktrees…
          </p>
        ) : visibleProjects.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-subtle">
            No local projects known to Rove yet.
          </p>
        ) : (
          visibleProjects.map((project) => (
            <div key={project.repo} className="border-b border-line">
              <div className="border-b border-line-subtle bg-surface px-3 py-1.5 font-mono text-[11px] text-subtle">
                {project.repo}
              </div>
              {project.worktrees.length === 0 ? (
                <p className="px-3 py-3 text-[12px] text-subtle">
                  No worktrees.
                </p>
              ) : (
                project.worktrees.map((row) => (
                  <WorktreeRowView
                    key={row.path}
                    row={row}
                    linkedTaskTitle={linkedTaskTitles.get(row.path) ?? null}
                    onDelete={() => setPendingDelete(row)}
                  />
                ))
              )}
            </div>
          ))
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete worktree"
          body={`Delete the worktree for "${pendingDelete.branch || pendingDelete.path}"? This removes the working directory; the branch itself is kept.`}
          confirmLabel="Delete"
          danger
          onConfirm={onConfirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingForceDelete && (
        <ConfirmDialog
          title="Force delete worktree"
          body={`"${pendingForceDelete.branch || pendingForceDelete.path}" has uncommitted or untracked changes that will be PERMANENTLY LOST. Force delete anyway?`}
          confirmLabel="Force delete"
          danger
          onConfirm={onConfirmForceDelete}
          onCancel={() => setPendingForceDelete(null)}
        />
      )}
    </div>
  )
}
