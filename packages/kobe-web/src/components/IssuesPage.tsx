import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, Plus, Search, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import {
  deleteIssue as deleteIssueOp,
  fetchProjects,
  filterIssues,
  groupByStatus,
  ISSUE_STATUSES,
  issueRepoOptions,
  promptIssueMerge,
  quickStartIssue,
  STATUS_META,
  updateIssue,
} from "../lib/issues.ts"
import { useAppState } from "../lib/store.ts"
import { ensureEngineTab } from "../lib/tabs.ts"
import { reportError } from "../lib/toast.ts"
import { useRepoIssues } from "../lib/use-repo-issues.ts"
import { ConfirmDialog } from "./ConfirmDialog.tsx"
import { DesktopWindowControls } from "./DesktopWindowControls.tsx"
import { IssueCard } from "./IssueCard.tsx"
import {
  IssuePanelSuspense,
  LazyIssueIntakePanel,
  LazyIssuePeek,
} from "./lazy-issue-panels.tsx"

export function IssuesPage() {
  const { tasks, hydrated } = useAppState()
  const navigate = useNavigate()
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

  const repos = useMemo(
    () => issueRepoOptions(tasks, projectRepos),
    [tasks, projectRepos],
  )
  const [repo, setRepo] = useState<string | null>(null)
  useEffect(() => {
    if (repos.length === 0) {
      if (repo !== null) setRepo(null)
      return
    }
    if (!repo || !repos.some((r) => r.repo === repo)) {
      setRepo(repos[0]?.repo ?? null)
    }
  }, [repos, repo])

  const repoKeys = useMemo(() => (repo ? [repo] : []), [repo])
  const { data, failed, pending } = useRepoIssues(repoKeys)
  const repoState = repo ? data[repo] : undefined

  const [query, setQuery] = useState("")
  const [intakeOpen, setIntakeOpen] = useState(false)
  const [peekId, setPeekId] = useState<number | null>(null)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [savingPeek, setSavingPeek] = useState(false)
  const [starting, setStarting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const issues = repoState?.issues ?? []
  const filtered = useMemo(
    () => filterIssues(issues, { query }),
    [issues, query],
  )
  const columns = useMemo(() => groupByStatus(filtered), [filtered])
  const total = filtered.length

  const peekIssue = peekId != null ? issues.find((i) => i.id === peekId) : null
  const deleteIssue =
    deleteId != null ? issues.find((i) => i.id === deleteId) : null

  useEffect(() => {
    if (peekId != null && !issues.some((i) => i.id === peekId)) setPeekId(null)
    if (deleteId != null && !issues.some((i) => i.id === deleteId)) {
      setDeleteId(null)
    }
  }, [issues, peekId, deleteId])

  const openTaskWorkspace = (taskId: string): void => {
    void navigate({ to: "/task/$taskId", params: { taskId } })
  }

  const onSavePeek = async (patch: {
    title: string
    body: string
  }): Promise<boolean> => {
    if (!repo || peekId == null) return false
    setSavingPeek(true)
    try {
      await updateIssue(repo, peekId, {
        title: patch.title.trim(),
        body: patch.body,
      })
      return true
    } catch (err) {
      reportError("save issue", err)
      return false
    } finally {
      setSavingPeek(false)
    }
  }

  const onStartPeek = (opts: {
    vendor?: string
    effort?: string
    watch: boolean
  }): void => {
    if (!repo || !peekIssue) return
    setStarting(true)
    void quickStartIssue(repo, peekIssue, opts.vendor, opts.effort)
      .then(({ taskId }) => {
        setPeekId(null)
        if (opts.watch) openTaskWorkspace(taskId)
      })
      .catch((err: unknown) => reportError("start issue", err))
      .finally(() => setStarting(false))
  }

  const onConfirmDelete = (): void => {
    if (!repo || deleteId == null) return
    setDeleting(true)
    void deleteIssueOp(repo, deleteId)
      .then(() => setDeleteId(null))
      .catch((err: unknown) => reportError("delete issue", err))
      .finally(() => setDeleting(false))
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
          Issues
        </span>
        <label className="flex h-7 items-center gap-1.5 border border-line bg-bg px-2 text-muted focus-within:border-line-active">
          <Search
            size={13}
            strokeWidth={1.8}
            className="shrink-0 text-subtle"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter stories  ( #id, title, body )"
            className="w-52 bg-transparent text-[12px] text-fg placeholder:text-subtle focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="shrink-0 text-subtle hover:text-fg"
              aria-label="clear filter"
              title="Clear filter"
            >
              <X size={13} strokeWidth={2} />
            </button>
          )}
        </label>
        {}
        {repos.length > 0 && (
          <label className="flex h-7 min-w-0 max-w-[24rem] items-center gap-1.5 border border-line bg-bg px-2 text-muted focus-within:border-line-active">
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Project
            </span>
            <select
              value={repo ?? ""}
              onChange={(event) => setRepo(event.target.value)}
              title={repo ?? "Select project"}
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-fg focus:outline-none"
            >
              {repos.map((option) => (
                <option
                  key={option.repo}
                  value={option.repo}
                  title={option.repo}
                  className="bg-surface text-fg"
                >
                  {option.label} · {option.count} · {option.repo}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-subtle">
          <span>
            {total} stor{total === 1 ? "y" : "ies"}
          </span>
          <button
            type="button"
            disabled={!repo}
            onClick={() => setIntakeOpen(true)}
            className="flex items-center gap-1.5 border border-primary bg-inset px-2 py-0.5 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
            title="Capture a new story"
          >
            <Plus size={13} strokeWidth={1.8} />
            New story
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
        {!repo ? (
          <p className="text-[12px] text-subtle">
            No projects yet. Create a task from the workspace to track stories
            against its repo.
          </p>
        ) : !hydrated || (pending && !repoState) ? (
          <p className="text-[12px] text-subtle">Loading…</p>
        ) : repo && failed[repo] ? (
          <p className="text-[12px] text-kobe-red">{failed[repo]}</p>
        ) : total === 0 ? (
          <p className="text-[12px] text-subtle">
            {query
              ? "No stories match your filter."
              : "No stories yet. Capture one with New story."}
          </p>
        ) : (
          <div className="flex h-full min-h-0 gap-4">
            {ISSUE_STATUSES.map((status) => {
              const meta = STATUS_META[status]
              const list = columns[status]
              return (
                <section
                  key={status}
                  className="flex h-full min-h-0 w-72 shrink-0 flex-col"
                >
                  <div className="mb-2 flex shrink-0 items-center gap-2">
                    <h2
                      className={`text-[10px] font-bold uppercase tracking-[0.12em] ${meta.accent}`}
                    >
                      {meta.title}
                    </h2>
                    <span className="font-mono text-[10px] text-subtle">
                      {list.length}
                    </span>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
                    {list.map((issue) => (
                      <IssueCard
                        key={issue.id}
                        issue={issue}
                        onOpen={() => setPeekId(issue.id)}
                        onDelete={() => setDeleteId(issue.id)}
                      />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>

      {repo && intakeOpen && (
        <IssuePanelSuspense>
          <LazyIssueIntakePanel
            repoRoot={repo}
            open={intakeOpen}
            onClose={() => setIntakeOpen(false)}
            onCreated={(issue, started) => {
              if (started && issue.taskId) openTaskWorkspace(issue.taskId)
            }}
          />
        </IssuePanelSuspense>
      )}

      {repo && peekIssue && (
        <IssuePanelSuspense>
          <LazyIssuePeek
            issue={peekIssue}
            repoRoot={repo}
            busy={savingPeek}
            starting={starting}
            onClose={() => setPeekId(null)}
            onSave={onSavePeek}
            onStart={onStartPeek}
            onOpenSession={
              peekIssue.taskId
                ? () => {
                    const taskId = peekIssue.taskId
                    if (!taskId) return
                    ensureEngineTab(taskId)
                    openTaskWorkspace(taskId)
                  }
                : undefined
            }
            onPromptMerge={
              peekIssue.taskId
                ? () => {
                    const taskId = peekIssue.taskId
                    if (!taskId) return
                    void promptIssueMerge(taskId, peekIssue).catch(
                      (err: unknown) => reportError("prompt issue merge", err),
                    )
                  }
                : undefined
            }
          />
        </IssuePanelSuspense>
      )}

      {deleteIssue && (
        <ConfirmDialog
          title="Delete issue"
          body={`Delete issue #${deleteIssue.id} "${deleteIssue.title}"? This removes only the issue record — any linked task, branch, or worktree is left untouched.`}
          confirmLabel="Delete"
          danger
          busy={deleting}
          onConfirm={onConfirmDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  )
}
