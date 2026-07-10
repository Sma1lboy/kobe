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
 * that issue into the In progress column (lib/use-issue-actions.ts) so the
 * board reflects the start before the snapshot's `taskId` link lands. There is
 * NO per-card live engine / worktree / task.snapshot subscription — that was
 * the old unified board's lag source and is gone. Column rendering lives in
 * BoardColumns.tsx.
 */

import { useNavigate } from "@tanstack/react-router"
import { Plus, Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { setActiveTaskBestEffort } from "../lib/active-task.ts"
import { buildBoardView } from "../lib/board.ts"
import {
  setBoardQuery,
  setBoardRepo,
  useBoardState,
} from "../lib/board-state.ts"
import {
  fetchProjects,
  type Issue,
  issueRepoOptions,
  promptIssueMerge,
  resolveIssueRepoSelection,
} from "../lib/issues.ts"
import { useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import { useIssueActions } from "../lib/use-issue-actions.ts"
import { useRepoIssues } from "../lib/use-repo-issues.ts"
import { ProjectColumns } from "./BoardColumns.tsx"
import { ConfirmDialog } from "./ConfirmDialog.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { DesktopWindowControls } from "./DesktopWindowControls.tsx"
import {
  IssuePanelSuspense,
  LazyIssueIntakePanel,
  LazyIssuePeek,
} from "./lazy-issue-panels.tsx"
import { ViewToggle } from "./ViewToggle.tsx"

/** A peek target is repo-scoped: an issue number alone would be ambiguous
 *  across projects. */
type PeekTarget = { repo: string; id: number }

export function Board() {
  const { tasks, hydrated, daemonConnected } = useAppState()
  const { query, repo: repoFilter } = useBoardState()
  const navigate = useNavigate()
  const filterRef = useRef<HTMLInputElement>(null)
  const [peek, setPeek] = useState<PeekTarget | null>(null)
  // Issue-intake panel target repo (null = closed).
  const [creatingRepo, setCreatingRepo] = useState<string | null>(null)
  // Issue pending a delete confirmation (null = no dialog). Carries its source
  // repo so the confirmed delete hits the right daemon store key.
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

  // Issue-snapshot plumbing for every source repo on the board. Project
  // options come from tasks/main rows, not existing issues, so an empty project
  // can still be selected and receive its first issue.
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
  const {
    issueBusy,
    quickStartingId,
    pendingLinks,
    saveIssue,
    deleteIssueConfirmed,
    quickStart,
  } = useIssueActions({ issueRepos, issueData, refreshIssues })

  // The whole derived view (flat issue list + chips + project boards + counts)
  // is one pure call into lib/board — the component holds no board-derivation
  // logic of its own, so that logic is unit-tested via buildBoardView, not the
  // DOM. `allIssues` is UNfiltered (drives chips + peek lookups + the empty
  // check); `projectBoards`/`shownCount` are post-filter.
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

  // A project selection is required for the kanban. If the current project
  // disappeared (or the page opened before one was chosen), snap to the first
  // available project from the task snapshot.
  useEffect(() => {
    if (repoFilter !== currentRepo) setBoardRepo(currentRepo)
  }, [currentRepo, repoFilter])

  // A no-match (chips/query narrowed every issue away) vs the genuinely-empty
  // board: the empty branch differs (clear-filters vs new-issue affordance).
  const filtered = Boolean(query)

  // Open a linked issue's task workspace/session.
  const openTask = (id: string): void => {
    selectTask(id)
    setActiveTaskBestEffort(id)
    void navigate({ to: "/task/$taskId", params: { taskId: id } })
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <header
        data-kobe-topbar
        className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-3"
      >
        <DesktopWindowControls />
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
        {/* Project selector: issue execution creates a task worktree under the
            selected project, so there is deliberately no "all projects" mode.
            Use a select, not chip tabs: workspaces can have many projects. */}
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
        {/* Hold the neutral "Loading…" until the issue GET has actually
            resolved. `hydrated` only covers the task snapshot — the issues
            arrive via a separate post-paint fetch, so gating on `hydrated`
            alone flashed the "No issues yet" empty state for one frame before
            the GET landed (the load twitch). `&& !hasAnyCard` keeps a later
            new-repo fetch from blanking a board that already shows cards. */}
        {!hydrated || (issuesPending && !hasAnyCard) ? (
          <p className="text-[12px] text-subtle">Loading…</p>
        ) : shownCount === 0 && filtered && hasAnyCard ? (
          // The text query narrowed every issue away — offer to clear it.
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
          // The daemon is down, so the issue list may be partial/stale — say so
          // rather than implying an empty board.
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

      {/* Floating New-story entry — the board is the story-intake surface, so
          an always-reachable + FAB opens the intake panel for the current
          project. */}
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
              // Refresh so the new issue lands in the Backlog at once (the
              // issue.snapshot push can miss the board's repo key via aliasing).
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
              onSave={(patch) => saveIssue(entry.repo, entry.issue.id, patch)}
              onStart={async ({ vendor, effort, watch }) => {
                const taskId = await quickStart(
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
            void deleteIssueConfirmed(
              confirmDelete.repo,
              confirmDelete.issue,
            ).then((ok) => {
              if (!ok) return
              setConfirmDelete(null)
              if (
                peek?.repo === confirmDelete.repo &&
                peek.id === confirmDelete.issue.id
              ) {
                setPeek(null)
              }
            })
          }
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}
