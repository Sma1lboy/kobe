import { useNavigate } from "@tanstack/react-router"
import { ExternalLink, Plus, Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { setActiveTaskBestEffort } from "../lib/active-task.ts"
import {
  type BoardColumn,
  buildBoardView,
  isLinkedIssue,
  type ProjectBoard,
} from "../lib/board.ts"
import {
  setBoardQuery,
  setBoardRepo,
  useBoardState,
} from "../lib/board-state.ts"
import {
  deleteIssue,
  fetchProjects,
  type Issue,
  issueRepoOptions,
  promptIssueMerge,
  quickStartIssue,
  resolveIssueRepoSelection,
  updateIssue,
} from "../lib/issues.ts"
import { useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import { useRepoIssues } from "../lib/use-repo-issues.ts"
import { ConfirmDialog } from "./ConfirmDialog.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { DesktopWindowControls } from "./DesktopWindowControls.tsx"
import { IssueCard } from "./IssueCard.tsx"
import {
  IssuePanelSuspense,
  LazyIssueIntakePanel,
  LazyIssuePeek,
} from "./lazy-issue-panels.tsx"
import { ViewToggle } from "./ViewToggle.tsx"

type PeekTarget = { repo: string; id: number }

function ColumnView({
  repo,
  column,
  onNewIssue,
  onPeekIssue,
  onOpenTask,
  onDeleteIssue,
}: {
  repo: string
  column: BoardColumn
  onNewIssue?: () => void
  onPeekIssue: (issue: Issue) => void
  onOpenTask: (taskId: string) => void
  onDeleteIssue: (issue: Issue) => void
}) {
  return (
    <section
      data-column={`${repo}:${column.key}`}
      className={`flex h-full shrink-0 flex-col border border-transparent ${
        column.key === "backlog" ? "w-96" : "w-72"
      }`}
    >
      <div className="mb-2 flex items-baseline gap-2">
        <h2
          className={`text-[11px] font-bold uppercase tracking-[0.12em] ${column.accent}`}
        >
          {column.title}
        </h2>
        <span className="font-mono text-[10px] text-subtle">
          {column.cards.length + column.hiddenCount}
        </span>
        {onNewIssue && (
          <button
            type="button"
            onClick={onNewIssue}
            className="ml-auto flex items-center gap-0.5 text-[10px] text-subtle transition-colors hover:text-fg"
            title="New story in this project"
          >
            <Plus size={11} strokeWidth={2} />
            <span>New story</span>
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
        {column.cards.length === 0 ? (
          <div className="border border-dashed border-line-subtle p-3 text-center text-[11px] text-subtle">
            none
          </div>
        ) : (
          column.cards.map((card) => {
            const { issue } = card
            const linkedTaskId = isLinkedIssue(issue) ? issue.taskId : undefined
            return (
              <div key={`issue:${issue.id}`} className="group/wrap relative">
                <IssueCard
                  issue={issue}
                  onOpen={() => onPeekIssue(issue)}
                  onDelete={() => onDeleteIssue(issue)}
                />
                {}
                {linkedTaskId && (
                  <button
                    type="button"
                    onClick={() => onOpenTask(linkedTaskId)}
                    aria-label={`Open task for issue #${issue.id}`}
                    title="Started — open task"
                    className="absolute bottom-2 right-2 flex items-center gap-1 border border-line bg-surface px-1.5 py-0.5 text-[10px] text-subtle opacity-0 transition-opacity hover:border-primary hover:text-fg focus-visible:opacity-100 group-hover/wrap:opacity-100"
                  >
                    <ExternalLink size={10} strokeWidth={1.8} />
                    <span>open task</span>
                  </button>
                )}
              </div>
            )
          })
        )}
        {column.hiddenCount > 0 && (
          <div className="p-2 text-center text-[10px] text-subtle">
            +{column.hiddenCount} more — finish stories to thin this column
          </div>
        )}
      </div>
    </section>
  )
}

function ProjectColumns({
  board,
  onNewIssue,
  onPeekIssue,
  onOpenTask,
  onDeleteIssue,
}: {
  board: ProjectBoard
  onNewIssue: (repo: string) => void
  onPeekIssue: (issue: Issue) => void
  onOpenTask: (taskId: string) => void
  onDeleteIssue: (repo: string, issue: Issue) => void
}) {
  return (
    <div className="flex h-full min-w-max gap-4">
      {board.columns.map((column) => (
        <ColumnView
          key={column.key}
          repo={board.repo}
          column={column}
          onNewIssue={
            column.key === "backlog" ? () => onNewIssue(board.repo) : undefined
          }
          onPeekIssue={onPeekIssue}
          onOpenTask={onOpenTask}
          onDeleteIssue={(issue) => onDeleteIssue(board.repo, issue)}
        />
      ))}
    </div>
  )
}

export function Board() {
  const { tasks, hydrated, daemonConnected } = useAppState()
  const { query, repo: repoFilter } = useBoardState()
  const navigate = useNavigate()
  const filterRef = useRef<HTMLInputElement>(null)
  const [peek, setPeek] = useState<PeekTarget | null>(null)
  const [creatingRepo, setCreatingRepo] = useState<string | null>(null)
  const [issueBusy, setIssueBusy] = useState(false)
  const [quickStartingId, setQuickStartingId] = useState<number | null>(null)
  const [pendingLinks, setPendingLinks] = useState<
    Map<string, { repo: string; issueId: number; taskId: string }>
  >(new Map())
  const [confirmDelete, setConfirmDelete] = useState<{
    repo: string
    issue: Issue
  } | null>(null)
  const [projectRepos, setProjectRepos] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void fetchProjects()
      .then((repos) => {
        if (!cancelled) setProjectRepos(repos)
      })
      .catch((err: unknown) => reportError("load projects", err))
    return () => {
      cancelled = true
    }
  }, [])

  const repoOptions = useMemo(
    () => issueRepoOptions(tasks, projectRepos),
    [tasks, projectRepos],
  )
  const issueRepos = useMemo(
    () => repoOptions.map((option) => option.repo),
    [repoOptions],
  )
  const currentRepo = useMemo(
    () => resolveIssueRepoSelection(repoOptions, repoFilter),
    [repoOptions, repoFilter],
  )
  const {
    data: issueData,
    pending: issuesPending,
    refresh: refreshIssues,
  } = useRepoIssues(issueRepos)

  const { allIssues, repoChips, projectBoards, shownCount, hasAnyCard } =
    useMemo(
      () =>
        buildBoardView({
          issueData,
          issueRepos,
          pendingLinks,
          query,
          repoFilter: currentRepo,
        }),
      [issueData, issueRepos, pendingLinks, query, currentRepo],
    )

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

  useEffect(() => {
    if (!peek) return
    if (
      !allIssues.some((e) => e.repo === peek.repo && e.issue.id === peek.id)
    ) {
      setPeek(null)
    }
  }, [allIssues, peek])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (peek || creatingRepo || confirmDelete) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const t = event.target as HTMLElement | null
      const inField =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      if (event.key === "/" && !inField) {
        event.preventDefault()
        filterRef.current?.focus()
      } else if (event.key === "Escape" && t === filterRef.current && query) {
        event.preventDefault()
        setBoardQuery("")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [query, peek, creatingRepo, confirmDelete])

  useEffect(() => {
    if (repoFilter !== currentRepo) setBoardRepo(currentRepo)
  }, [currentRepo, repoFilter])

  const filtered = Boolean(query)

  const openTask = (id: string): void => {
    selectTask(id)
    setActiveTaskBestEffort(id)
    void navigate({ to: "/task/$taskId", params: { taskId: id } })
  }

  const doSaveIssue = async (
    repo: string,
    id: number,
    patch: { title: string; body: string },
  ): Promise<boolean> => {
    setIssueBusy(true)
    try {
      await updateIssue(repo, id, patch)
      refreshIssues([repo])
      return true
    } catch (err) {
      reportError("update issue", err)
      return false
    } finally {
      setIssueBusy(false)
    }
  }

  const doDeleteIssue = async (repo: string, issue: Issue): Promise<void> => {
    setIssueBusy(true)
    try {
      await deleteIssue(repo, issue.id)
      refreshIssues([repo])
      setConfirmDelete(null)
      if (peek?.repo === repo && peek.id === issue.id) setPeek(null)
    } catch (err) {
      reportError("delete issue", err)
    } finally {
      setIssueBusy(false)
    }
  }

  const doQuickStart = async (
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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <header
        data-kobe-topbar
        className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-3"
      >
        <DesktopWindowControls />
        {}
        <span className="font-mono text-[13px] font-bold text-primary">
          [kobe]
        </span>
        <ViewToggle />
        <label className="flex h-7 items-center gap-1.5 border border-line bg-bg px-2 text-muted focus-within:border-line-active">
          <Search
            size={13}
            strokeWidth={1.8}
            className="shrink-0 text-subtle"
          />
          <input
            ref={filterRef}
            value={query}
            onChange={(event) => setBoardQuery(event.target.value)}
            placeholder="Filter stories  ( / )"
            className="w-44 bg-transparent text-[12px] text-fg placeholder:text-subtle focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setBoardQuery("")}
              className="shrink-0 text-subtle hover:text-fg"
              aria-label="clear filter"
              title="Clear filter"
            >
              <X size={13} strokeWidth={2} />
            </button>
          )}
        </label>
        {}
        {repoOptions.length > 0 && (
          <label className="flex h-7 min-w-0 max-w-[24rem] items-center gap-1.5 border border-line bg-bg px-2 text-muted focus-within:border-line-active">
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Project
            </span>
            <select
              value={currentRepo ?? ""}
              onChange={(event) => setBoardRepo(event.target.value)}
              title={currentRepo ?? "Select project"}
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-fg focus:outline-none"
            >
              {repoOptions.map((option) => {
                const issueCount =
                  repoChips.find((chip) => chip.repo === option.repo)?.count ??
                  0
                return (
                  <option
                    key={option.repo}
                    value={option.repo}
                    title={option.repo}
                    className="bg-surface text-fg"
                  >
                    {option.label} · {issueCount} · {option.repo}
                  </option>
                )
              })}
            </select>
          </label>
        )}
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-subtle">
          <span>
            {shownCount} stor{shownCount === 1 ? "y" : "ies"}
          </span>
        </div>
      </header>

      <DaemonBanner />

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
        {}
        {!hydrated || (issuesPending && !hasAnyCard) ? (
          <p className="text-[12px] text-subtle">Loading…</p>
        ) : shownCount === 0 && filtered && hasAnyCard ? (
          <div className="text-[12px] leading-relaxed text-subtle">
            <p>No stories match.</p>
            <button
              type="button"
              onClick={() => {
                setBoardQuery("")
              }}
              className="mt-3 border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-primary hover:text-fg"
            >
              Clear filters
            </button>
          </div>
        ) : shownCount === 0 && !daemonConnected ? (
          <p className="text-[12px] text-subtle">
            Can't reach the daemon — issue list may be incomplete.
          </p>
        ) : projectBoards[0] ? (
          <ProjectColumns
            board={projectBoards[0]}
            onNewIssue={setCreatingRepo}
            onPeekIssue={(issue) =>
              setPeek({ repo: projectBoards[0].repo, id: issue.id })
            }
            onOpenTask={openTask}
            onDeleteIssue={(repo, issue) => setConfirmDelete({ repo, issue })}
          />
        ) : (
          <div className="text-[12px] leading-relaxed text-subtle">
            <p>
              No projects yet. Create a task from the workspace to track stories
              against its repo.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => navigate({ to: "/" })}
                className="border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-primary hover:text-fg"
              >
                Back to workspace
              </button>
            </div>
          </div>
        )}
      </div>

      {}
      {(() => {
        const target = currentRepo ?? projectBoards[0]?.repo ?? issueRepos[0]
        if (!target) return null
        return (
          <button
            type="button"
            onClick={() => setCreatingRepo(target)}
            title="New story"
            aria-label="New story"
            className="fixed bottom-6 right-6 z-20 flex h-12 w-12 items-center justify-center rounded-full border border-primary bg-primary text-bg shadow-lg transition-transform hover:scale-105"
          >
            <Plus size={22} strokeWidth={2.2} />
          </button>
        )
      })()}

      {creatingRepo && (
        <IssuePanelSuspense>
          <LazyIssueIntakePanel
            repoRoot={creatingRepo}
            open
            onClose={() => setCreatingRepo(null)}
            onCreated={(issue, started) => {
              if (creatingRepo) refreshIssues([creatingRepo])
              pushToast(
                "success",
                started
                  ? `Story #${issue.id} created — starting its session`
                  : `Story #${issue.id} created`,
              )
            }}
          />
        </IssuePanelSuspense>
      )}

      {(() => {
        if (!peek) return null
        const entry = allIssues.find(
          (e) => e.repo === peek.repo && e.issue.id === peek.id,
        )
        if (!entry) return null
        return (
          <IssuePanelSuspense>
            <LazyIssuePeek
              key={`${entry.repo}:${entry.issue.id}`}
              issue={entry.issue}
              repoRoot={entry.repo}
              busy={issueBusy}
              starting={quickStartingId === entry.issue.id}
              onClose={() => setPeek(null)}
              onSave={(patch) => doSaveIssue(entry.repo, entry.issue.id, patch)}
              onStart={async ({ vendor, effort, watch }) => {
                const taskId = await doQuickStart(
                  entry.repo,
                  entry.issue,
                  vendor,
                  effort,
                )
                if (watch && taskId) {
                  setPeek(null)
                  openTask(taskId)
                } else {
                  setPeek(null)
                }
              }}
              onOpenSession={
                entry.issue.taskId
                  ? () => {
                      const t = entry.issue.taskId
                      setPeek(null)
                      if (t) openTask(t)
                    }
                  : undefined
              }
              onPromptMerge={
                entry.issue.taskId
                  ? () => {
                      const t = entry.issue.taskId
                      if (!t) return
                      void promptIssueMerge(t, entry.issue)
                        .then(() =>
                          pushToast(
                            "success",
                            `Prompt inserted for story #${entry.issue.id}`,
                          ),
                        )
                        .catch((err: unknown) =>
                          reportError("prompt issue merge", err),
                        )
                    }
                  : undefined
              }
            />
          </IssuePanelSuspense>
        )
      })()}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete issue"
          body={`Delete issue #${confirmDelete.issue.id}: "${confirmDelete.issue.title}"? This removes it from the daemon issue tracker only; it does not delete any task, branch, worktree, or engine session.`}
          confirmLabel="Delete"
          danger
          busy={issueBusy}
          onConfirm={() =>
            void doDeleteIssue(confirmDelete.repo, confirmDelete.issue)
          }
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}
