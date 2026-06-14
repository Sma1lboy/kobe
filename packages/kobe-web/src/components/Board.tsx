/**
 * Board — the kanban lens over the daemon-owned Issues, grouped into one board
 * per Project (= git repo). It is ISSUES-ONLY: tasks are NOT cards here (they
 * live in the Workspace view). The columns bind to each issue's OWN lifecycle
 * via {@link issueColumnKey}: Backlog = open / hold / unlinked, In progress =
 * linked to a task (started), Done = done.
 *
 * Interaction grammar (one kind of card, no drag):
 *   - Clicking an issue opens the right-side IssuePeek drawer (edit title/body,
 *     pick an engine, Start) — Start spawns a task on the chosen engine via
 *     quickStartIssue and links the two.
 *   - A LINKED issue (its `taskId` set) keeps a small "started — open task"
 *     affordance that jumps to that task's workspace/session. The task itself
 *     is never reverse-displayed as a card.
 *
 * Issues are non-optimistic (the daemon issue.snapshot is truth), with ONE
 * exception: once a quickStart resolves with a taskId we optimistically flip
 * that issue into the In progress column (a local pending-link set) so the
 * board reflects the start before the snapshot's `taskId` link lands. There is
 * NO per-card live engine / worktree / task.snapshot subscription — that was
 * the old unified board's lag source and is gone.
 */

import { useNavigate } from "@tanstack/react-router"
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plus,
  Search,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  type BoardCard as BoardCardData,
  type BoardColumn,
  boardCardCount,
  buildProjectBoards,
  isLinkedIssue,
  labelRepo,
  type ProjectBoard,
} from "../lib/board.ts"
import {
  setBoardQuery,
  setBoardRepo,
  useBoardState,
} from "../lib/board-state.ts"
import {
  deleteIssue,
  type Issue,
  issueRepoOptions,
  quickStartIssue,
  updateIssue,
} from "../lib/issues.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import { useRepoIssues } from "../lib/use-repo-issues.ts"
import { ConfirmDialog } from "./ConfirmDialog.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { IssueCard } from "./IssueCard.tsx"
import { IssueIntakePanel } from "./IssueIntakePanel.tsx"
import { IssuePeek } from "./IssuePeek.tsx"
import { ViewToggle } from "./ViewToggle.tsx"

/** A peek target is repo-scoped: an issue number alone would be ambiguous
 *  across projects. */
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
  /** Backlog only — open the issue-intake panel scoped to this repo. */
  onNewIssue?: () => void
  onPeekIssue: (issue: Issue) => void
  /** Jump to a linked issue's task workspace/session. */
  onOpenTask: (taskId: string) => void
  /** Raise a delete request for an issue card — the Board confirms first. */
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
            title="New issue in this project"
          >
            <Plus size={11} strokeWidth={2} />
            <span>New issue</span>
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
                {/* Linked issue → a "started — open task" affordance that jumps
                    to the task's workspace. The task is not its own card; this
                    is the only place a linked task surfaces on the board. */}
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
            +{column.hiddenCount} more — finish issues to thin this column
          </div>
        )}
      </div>
    </section>
  )
}

/** One project's column row. */
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
  // Projects the user has collapsed (repo key set). Default expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Issue-intake panel target repo (null = closed).
  const [creatingRepo, setCreatingRepo] = useState<string | null>(null)
  const [issueBusy, setIssueBusy] = useState(false)
  const [quickStartingId, setQuickStartingId] = useState<number | null>(null)
  // Optimistic link: `${repo}:${issueId}` for issues whose quickStart has
  // resolved with a taskId but whose issue.snapshot link hasn't landed yet.
  // Promotes them into In progress for one round-trip; cleared once the daemon
  // confirms the link (the issue now carries a real taskId).
  const [pendingLinks, setPendingLinks] = useState<
    Map<string, { repo: string; issueId: number; taskId: string }>
  >(new Map())
  // Issue pending a delete confirmation (null = no dialog). Carries its source
  // repo so the confirmed delete hits the right daemon store key.
  const [confirmDelete, setConfirmDelete] = useState<{
    repo: string
    issue: Issue
  } | null>(null)

  // Issue-snapshot plumbing for every source repo on the board. issueRepoOptions
  // folds worktree tasks into their canonical source repo (the daemon issue
  // store is keyed there), so a repo's issues all share one key.
  const issueRepos = useMemo(
    () => issueRepoOptions(tasks).map((option) => option.repo),
    [tasks],
  )
  const { data: issueData, refresh: refreshIssues } = useRepoIssues(issueRepos)

  // The flat issue list (across every repo), each tagged with its source repo,
  // with the optimistic pending-link applied so a just-started issue already
  // carries its taskId (→ In progress) before the daemon snapshot lands.
  // Only `exists` repos contribute; a missing issue file is empty, not error.
  const allIssues = useMemo(() => {
    const out: Array<{ repo: string; issue: Issue }> = []
    for (const repo of issueRepos) {
      const state = issueData[repo]
      if (!state || !state.exists) continue
      for (const issue of state.issues) {
        const pending = pendingLinks.get(`${repo}:${issue.id}`)
        out.push(
          pending && !issue.taskId
            ? { repo, issue: { ...issue, taskId: pending.taskId } }
            : { repo, issue },
        )
      }
    }
    return out
  }, [issueRepos, issueData, pendingLinks])

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

  // Close the peek when its target vanishes (issue removed elsewhere) — a
  // drawer onto a dead target would error.
  useEffect(() => {
    if (!peek) return
    if (
      !allIssues.some((e) => e.repo === peek.repo && e.issue.id === peek.id)
    ) {
      setPeek(null)
    }
  }, [allIssues, peek])

  // Keyboard-first parity with Overview: `/` focuses the filter, Escape
  // clears it. Suppressed while typing in another field, and dormant while
  // a drawer/dialog owns the keyboard — `/` yanking focus to the background
  // filter would punch through the drawer's focus trap.
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

  // Project chips: the distinct repos that have any issues. Computed from the
  // UNfiltered list so chips (and their counts) don't vanish while one is
  // selected or a text query narrows the view.
  const repos = useMemo(() => {
    const counts = new Map<string, number>()
    for (const { repo } of allIssues) {
      counts.set(repo, (counts.get(repo) ?? 0) + 1)
    }
    const keys = [...counts.keys()]
    return keys
      .map((repo) => ({
        repo,
        label: labelRepo(repo, keys),
        count: counts.get(repo) ?? 0,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [allIssues])
  // A selected project can disappear entirely (last issue deleted) — snap back
  // to All rather than showing a permanently empty board.
  useEffect(() => {
    if (repoFilter && !repos.some((option) => option.repo === repoFilter)) {
      setBoardRepo(null)
    }
  }, [repos, repoFilter])

  // The DISPLAY issue set: repo chip + text query.
  const boardIssues = useMemo<BoardCardData[]>(() => {
    const q = query.trim().toLowerCase()
    return allIssues
      .filter(({ repo, issue }) => {
        if (repoFilter && repo !== repoFilter) return false
        if (!q) return true
        const haystack =
          `#${issue.id} ${issue.title} ${issue.body}`.toLowerCase()
        return haystack.includes(q)
      })
      .map(({ repo, issue }) => ({ repo, issue }))
  }, [allIssues, query, repoFilter])

  const projectBoards = useMemo(
    () => buildProjectBoards(boardIssues),
    [boardIssues],
  )
  const single = projectBoards.length === 1
  const shownCount = useMemo(
    () =>
      projectBoards.reduce(
        (sum, board) => sum + boardCardCount(board.columns),
        0,
      ),
    [projectBoards],
  )
  // A no-match (chips/query narrowed every issue away) vs the genuinely-empty
  // board: the empty branch differs (clear-filters vs new-issue affordance).
  const hasAnyCard = allIssues.length > 0
  const filtered = Boolean(query) || Boolean(repoFilter)

  // Open a linked issue's task workspace/session.
  const openTask = (id: string): void => {
    selectTask(id)
    void rpc("task.setActive", { taskId: id }).catch(() => {})
    void navigate({ to: "/task/$taskId", params: { taskId: id } })
  }

  const toggleCollapsed = (repo: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(repo)) next.delete(repo)
      else next.add(repo)
      return next
    })
  }

  /* ----- issue side-effects ------------------------------------------------- */

  const doSaveIssue = async (
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
  // session it was linked to is left untouched (the link is one-way). The
  // daemon also pushes issue.snapshot, but its repoRoot aliasing can miss the
  // board's repo key — refresh the GET so the card drops from the list at once.
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

  // Spawn a task for the issue and RETURN its id so the caller decides whether
  // to watch (open the live session) or stay on the board. The optimistic
  // pending-link still happens here — it's a property of the spawn, not of how
  // the caller reacts. Navigation/peek routing is the caller's job (onStart).
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
      // Optimistically promote the issue into In progress (carry the new
      // taskId) so the start reads at once; the effect over issueData clears
      // this once the daemon confirms the link.
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
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        {/* Workspace ↔ Board are peer views — the top-left toggle is the only
            switch between them (no back link). The [kobe] brand mirrors the
            Workspace header so the logo + toggle sit identically in both. */}
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
            placeholder="Filter issues  ( / )"
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
        {/* Project chips: scope the board to one project. Hidden for a
            single-project board — no point paying header space for a
            filter with one value. Click the active chip to deselect. */}
        {repos.length >= 2 && (
          <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
            <button
              type="button"
              onClick={() => setBoardRepo(null)}
              className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                repoFilter === null
                  ? "border-line-active bg-inset text-fg"
                  : "border-line text-subtle hover:text-fg"
              }`}
            >
              all
            </button>
            {repos.map((option) => (
              <button
                key={option.repo}
                type="button"
                title={option.repo}
                onClick={() =>
                  setBoardRepo(repoFilter === option.repo ? null : option.repo)
                }
                className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                  repoFilter === option.repo
                    ? "border-line-active bg-inset text-fg"
                    : "border-line text-subtle hover:text-fg"
                }`}
              >
                {option.label}
                <span
                  className={
                    repoFilter === option.repo ? "text-muted" : "text-subtle"
                  }
                >
                  {" "}
                  {option.count}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-subtle">
          <span>
            {shownCount} issue{shownCount === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      <DaemonBanner />

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
        {!hydrated ? (
          <p className="text-[12px] text-subtle">Loading…</p>
        ) : shownCount === 0 && filtered && hasAnyCard ? (
          // The project chip and/or text query narrowed every issue away —
          // offer to clear BOTH (the rail's clear-filters move).
          <div className="text-[12px] leading-relaxed text-subtle">
            <p>No issues match.</p>
            <button
              type="button"
              onClick={() => {
                setBoardRepo(null)
                setBoardQuery("")
              }}
              className="mt-3 border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-primary hover:text-fg"
            >
              Clear filters
            </button>
          </div>
        ) : shownCount === 0 && !daemonConnected ? (
          // The daemon is down, so the issue list may be partial/stale — say so
          // rather than implying an empty board.
          <p className="text-[12px] text-subtle">
            Can't reach the daemon — issue list may be incomplete.
          </p>
        ) : shownCount === 0 ? (
          // Connected, genuinely no issues — offer the ways out.
          <div className="text-[12px] leading-relaxed text-subtle">
            <p>No issues yet. Create one to start tracking work.</p>
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
        ) : single ? (
          // One project — render ungrouped (no section header).
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
          // Multiple projects — one collapsible section each.
          <div className="flex h-full flex-col gap-4">
            {projectBoards.map((board) => {
              const isCollapsed = collapsed.has(board.repo)
              const count = boardCardCount(board.columns)
              return (
                <section
                  key={board.repo}
                  className={`flex flex-col ${
                    isCollapsed ? "shrink-0" : "min-h-0 flex-1"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(board.repo)}
                    title={board.repo}
                    className="mb-2 flex shrink-0 items-center gap-1.5 text-left text-muted transition-colors hover:text-fg"
                  >
                    {isCollapsed ? (
                      <ChevronRight size={13} strokeWidth={2} />
                    ) : (
                      <ChevronDown size={13} strokeWidth={2} />
                    )}
                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-fg">
                      {board.label}
                    </span>
                    <span className="font-mono text-[10px] text-subtle">
                      {count}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="min-h-0 flex-1 overflow-x-auto">
                      <ProjectColumns
                        board={board}
                        onNewIssue={setCreatingRepo}
                        onPeekIssue={(issue) =>
                          setPeek({ repo: board.repo, id: issue.id })
                        }
                        onOpenTask={openTask}
                        onDeleteIssue={(repo, issue) =>
                          setConfirmDelete({ repo, issue })
                        }
                      />
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>

      {/* Floating New-issue entry — the board is the ticket-intake surface, so
          a always-reachable + FAB (bottom-right) opens the intake panel for the
          active project chip, else the first project. */}
      {(() => {
        const target = repoFilter ?? projectBoards[0]?.repo ?? issueRepos[0]
        if (!target) return null
        return (
          <button
            type="button"
            onClick={() => setCreatingRepo(target)}
            title="New issue"
            aria-label="New issue"
            className="fixed bottom-6 right-6 z-20 flex h-12 w-12 items-center justify-center rounded-full border border-primary bg-primary text-bg shadow-lg transition-transform hover:scale-105"
          >
            <Plus size={22} strokeWidth={2.2} />
          </button>
        )
      })()}

      {creatingRepo && (
        <IssueIntakePanel
          repoRoot={creatingRepo}
          open
          onClose={() => setCreatingRepo(null)}
          onCreated={(issue, started) => {
            // Refresh so the new issue lands in the Backlog at once (the
            // issue.snapshot push can miss the board's repo key via aliasing).
            if (creatingRepo) refreshIssues([creatingRepo])
            pushToast(
              "success",
              started
                ? `Issue #${issue.id} created — starting its task`
                : `Issue #${issue.id} created`,
            )
          }}
        />
      )}

      {(() => {
        if (!peek) return null
        const entry = allIssues.find(
          (e) => e.repo === peek.repo && e.issue.id === peek.id,
        )
        if (!entry) return null
        return (
          <IssuePeek
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
              // Watch = drop the user straight into the live session;
              // otherwise spawn-and-stay closes the drawer back to the board.
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
          />
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
