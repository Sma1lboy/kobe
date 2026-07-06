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
            <span className="shrink-0 text-[10px] text-subtle">kobe</span>
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
  const [busy, setBusy] = useState(false)

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

  const removeRow = (path: string): void => {
    setProjects(
      (prev) =>
        prev?.map((project) => ({
          ...project,
          worktrees: project.worktrees.filter((w) => w.path !== path),
        })) ?? prev,
    )
  }

  const onConfirmDelete = (): void => {
    if (!pendingDelete) return
    const row = pendingDelete
    setBusy(true)
    void removeWorktree(row.path, false)
      .then(() => {
        removeRow(row.path)
        setPendingDelete(null)
      })
      .catch((err: unknown) => {
        setPendingDelete(null)
        if (err instanceof DirtyWorktreeError) {
          setPendingForceDelete(row)
        } else {
          reportError("delete worktree", err)
        }
      })
      .finally(() => setBusy(false))
  }

  const onConfirmForceDelete = (): void => {
    if (!pendingForceDelete) return
    const row = pendingForceDelete
    setBusy(true)
    void removeWorktree(row.path, true)
      .then(() => {
        removeRow(row.path)
        setPendingForceDelete(null)
      })
      .catch((err: unknown) => reportError("force delete worktree", err))
      .finally(() => setBusy(false))
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
        ) : projects.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-subtle">
            No local projects known to kobe yet.
          </p>
        ) : (
          projects.map((project) => (
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
          busy={busy}
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
          busy={busy}
          onConfirm={onConfirmForceDelete}
          onCancel={() => setPendingForceDelete(null)}
        />
      )}
    </div>
  )
}
