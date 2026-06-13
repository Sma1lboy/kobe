/**
 * Issues — the web lens over the daemon-owned issue tracker
 * (docs/WORK-TRACKING.md): a project switcher with a cross-project
 * overview, four status columns (open / doing / hold / done) in the
 * Board's kanban grammar, inline create/edit, a detail peek drawer, and
 * one-click quick start that spawns a kobe task on an issue via the
 * existing task-creation + PTY plumbing (lib/issues.ts).
 *
 * Data flow: initial loads use `/api/issues`; every daemon issue mutation
 * also publishes `issue.snapshot`, and the page replaces its per-repo cache
 * from that push. No optimistic layer; the daemon store is the only truth.
 */

import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, Play, Plus, RefreshCw, Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  canQuickStart,
  createIssue,
  fetchIssues,
  filterIssues,
  groupByStatus,
  ISSUE_STATUSES,
  type Issue,
  type IssueStatus,
  issueRepoOptions,
  overviewRows,
  quickStartIssue,
  type RepoIssues,
  STATUS_META,
  setIssueStatus,
  statusActions,
  updateIssue,
} from "../lib/issues.ts"
import { useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import { useFocusTrap } from "../lib/use-focus-trap.ts"
import { TIP_ABOVE } from "./chips.tsx"
import { IssuePeek } from "./IssuePeek.tsx"

function IssueCard({
  issue,
  busy,
  quickStartBusy,
  onSetStatus,
  onQuickStart,
  onOpen,
}: {
  issue: Issue
  busy: boolean
  quickStartBusy: boolean
  onSetStatus: (to: IssueStatus) => void
  onQuickStart: () => void
  onOpen: () => void
}) {
  return (
    <div className="group/card relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer flex-col gap-1.5 border border-line bg-surface p-3 text-left transition-colors hover:border-primary hover:bg-inset"
      >
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-[10px] text-subtle">
            #{issue.id}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
            {issue.title}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-subtle">
          <span className="font-mono">{issue.created}</span>
        </div>
      </button>
      {/* Hover bar: status moves + quick start. Overlays the card footer on
          hover only (the Board card grammar). */}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 border-t border-line bg-surface px-2 py-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100">
        {statusActions(issue.status).map((action) => (
          <button
            key={action.to}
            type="button"
            disabled={busy}
            onClick={() => onSetStatus(action.to)}
            title={`Move to ${STATUS_META[action.to].title}`}
            className="px-1 text-[10px] text-subtle transition-colors hover:text-fg disabled:opacity-40"
          >
            {action.label}
          </button>
        ))}
        {canQuickStart(issue.status) && (
          <button
            type="button"
            disabled={quickStartBusy}
            onClick={onQuickStart}
            aria-label={`Quick start issue #${issue.id}`}
            data-tip="Quick start — spawn a kobe task"
            className={`relative ml-auto flex h-5 w-5 items-center justify-center border border-line bg-surface text-subtle hover:border-primary hover:text-fg disabled:opacity-40 ${TIP_ABOVE}`}
          >
            <Play size={11} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  )
}

function NewIssueDialog({
  busy,
  onCreate,
  onClose,
}: {
  busy: boolean
  onCreate: (title: string, body: string) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  const canCreate = title.trim().length > 0 && !busy
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is a convenience; Escape + the Cancel button are the accessible paths.
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose()
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="New issue"
        className="w-[28rem] max-w-[calc(100vw-2rem)] border border-line bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={() => {}}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
            New Issue
          </span>
          <span className="font-mono text-[10px] text-subtle">
            daemon store
          </span>
        </div>
        <form
          className="space-y-3 px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (canCreate) onCreate(title.trim(), body)
          }}
        >
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Title
            </div>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs doing?"
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to type a title; focus belongs there on open.
              autoFocus
              className="w-full border border-line bg-bg px-2 py-1.5 text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
            />
          </div>
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Body
            </div>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="optional — context, repro, acceptance (markdown)"
              rows={6}
              className="w-full resize-none border border-line bg-bg px-2 py-1.5 font-mono text-[12px] leading-relaxed text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="border border-line bg-bg px-3 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canCreate}
              className="border border-primary bg-inset px-3 py-1 text-[11px] text-fg transition-colors hover:bg-primary/10 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create issue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function isNonGitRepoFailure(message: string | undefined): boolean {
  return message?.includes("repoRoot is not a git repository") ?? false
}

export function IssuesPage() {
  const { tasks, hydrated, issueSnapshots } = useAppState()
  const navigate = useNavigate()
  const [repo, setRepo] = useState<string | null>(null)
  const [data, setData] = useState<Record<string, RepoIssues>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")
  // Peek state is scoped to its repo (the Board precedent never
  // cross-matches): a bare issue number would collide across repos after
  // the snap-back effect nulls `repo`, auto-opening the wrong repo's issue.
  const [peek, setPeek] = useState<{ repo: string; id: number } | null>(null)
  const [creating, setCreating] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [quickStartingId, setQuickStartingId] = useState<number | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  // Project chips: one per canonical source repo. Worktree tasks fold into
  // task.repo because the daemon issue store is keyed by the shared git dir.
  const repos = useMemo(() => issueRepoOptions(tasks), [tasks])
  const visibleRepos = useMemo(
    () => repos.filter((option) => !isNonGitRepoFailure(failed[option.repo])),
    [repos, failed],
  )
  const repoLabels = useMemo(
    () =>
      new Map(
        visibleRepos.map((option) => [option.repo, option.label] as const),
      ),
    [visibleRepos],
  )

  // Out-of-order guard (the DiffView seqRef pattern, per repo): every
  // request captures a token when it starts, and applyState drops a
  // response whose token is older than the last one applied for that repo.
  // Mutations bump the token too, so an in-flight refresh GET can never
  // overwrite a fresher mutation response.
  const seqRef = useRef(new Map<string, number>())
  const appliedSeqRef = useRef(new Map<string, number>())
  const beginRequest = (root: string): number => {
    const seq = (seqRef.current.get(root) ?? 0) + 1
    seqRef.current.set(root, seq)
    return seq
  }

  const applyState = (
    state: RepoIssues,
    seq: number,
    cacheKey = state.repoRoot,
  ): void => {
    if (seq < (appliedSeqRef.current.get(cacheKey) ?? 0)) return
    appliedSeqRef.current.set(cacheKey, seq)
    setData((prev) => ({
      ...prev,
      [cacheKey]: { ...state, repoRoot: cacheKey },
    }))
    setFailed((prev) => {
      if (!(cacheKey in prev)) return prev
      const { [cacheKey]: _gone, ...rest } = prev
      return rest
    })
  }

  const refresh = (roots: readonly string[]): void => {
    if (roots.length === 0) return
    setLoading(true)
    void Promise.all(
      roots.map(async (root) => {
        const seq = beginRequest(root)
        try {
          applyState(await fetchIssues(root), seq, root)
        } catch (err) {
          setFailed((prev) => ({
            ...prev,
            [root]: err instanceof Error ? err.message : String(err),
          }))
        }
      }),
    ).finally(() => setLoading(false))
  }

  // Fetch every project's issues in parallel when the repo set settles or
  // its membership changes (keyed by membership, not array identity — the
  // tasks list refreshes constantly).
  const repoKey = repos.map((option) => option.repo).join("\n")
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoKey is the membership fingerprint; refetching on every `repos` identity change would hammer the bridge.
  useEffect(() => {
    refresh(repoKey ? repoKey.split("\n") : [])
  }, [repoKey])

  // Live daemon broadcasts: an issue mutation from any surface (another
  // browser, TUI, or `kobe api issue-*`) arrives as the repo's full
  // RepoIssues state. Cache it under every matching project-chip key so
  // `/repo` and `/repo/` don't split the UI cache.
  // biome-ignore lint/correctness/useExhaustiveDependencies: issueSnapshots + repos are the event inputs; beginRequest/applyState are render-local helpers over stable refs/setters and would retrigger this effect every render.
  useEffect(() => {
    const normalize = (root: string): string =>
      root.length > 1 ? root.replace(/\/+$/, "") : root
    const byNormalized = new Map(
      Object.values(issueSnapshots).map((state) => [
        normalize(state.repoRoot),
        state,
      ]),
    )
    for (const option of visibleRepos) {
      const pushed = byNormalized.get(normalize(option.repo))
      if (!pushed) continue
      const seq = beginRequest(option.repo)
      applyState(pushed, seq, option.repo)
    }
  }, [issueSnapshots, visibleRepos])

  // A selected project can disappear (its last task archived) — snap back
  // to the overview rather than a permanently stale view (Board precedent).
  useEffect(() => {
    if (repo && !visibleRepos.some((option) => option.repo === repo)) {
      setRepo(null)
    }
  }, [visibleRepos, repo])

  // Keyboard-first parity with Board/Overview: `/` focuses the filter,
  // Escape clears it. Dormant while a drawer/dialog owns the keyboard.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (peek !== null || creating) return
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
        setQuery("")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [query, peek, creating])

  const selected = repo ? data[repo] : undefined
  const peekIssue =
    repo && peek !== null && peek.repo === repo
      ? selected?.issues.find((issue) => issue.id === peek.id)
      : undefined

  // Close the peek when its issue vanishes (e.g. removed by an external
  // edit + refresh, or the selected repo changed) — a drawer onto a dead
  // issue would just error.
  useEffect(() => {
    if (peek !== null && repo && selected && !peekIssue) setPeek(null)
  }, [peek, repo, selected, peekIssue])

  const doSetStatus = (root: string, id: number, to: IssueStatus): void => {
    setMutating(true)
    const seq = beginRequest(root)
    setIssueStatus(root, id, to)
      .then((state) => applyState(state, seq, root))
      .catch((err: unknown) => reportError("move issue", err))
      .finally(() => setMutating(false))
  }

  const doCreate = (root: string, title: string, body: string): void => {
    setMutating(true)
    const seq = beginRequest(root)
    createIssue(root, body.trim() ? { title, body } : { title })
      .then((state) => {
        applyState(state, seq, root)
        setCreating(false)
        const created = state.issues[0]
        pushToast(
          "success",
          created ? `Issue #${created.id} created` : "Issue created",
        )
      })
      .catch((err: unknown) => reportError("create issue", err))
      .finally(() => setMutating(false))
  }

  const doSave = async (
    root: string,
    id: number,
    patch: { title: string; body: string },
  ): Promise<boolean> => {
    setMutating(true)
    const seq = beginRequest(root)
    try {
      applyState(await updateIssue(root, id, patch), seq, root)
      return true
    } catch (err) {
      reportError("update issue", err)
      return false
    } finally {
      setMutating(false)
    }
  }

  const doQuickStart = (root: string, issue: Issue): void => {
    if (quickStartingId !== null) return
    setQuickStartingId(issue.id)
    quickStartIssue(root, issue)
      .then(({ taskId }) => {
        selectTask(taskId)
        void navigate({ to: "/task/$taskId", params: { taskId } })
      })
      .catch((err: unknown) => reportError("quick start issue", err))
      .finally(() => setQuickStartingId(null))
  }

  /* ----- derived views ---------------------------------------------------- */

  const rows = useMemo(() => {
    // Failed repos render only their dashed failure card (the project view
    // gives `failed` the same precedence) — a stale snapshot row alongside
    // it would show the repo twice.
    const loaded = visibleRepos
      .filter((option) => !(option.repo in failed))
      .map((option) => data[option.repo])
      .filter((state): state is RepoIssues => !!state && state.exists)
    return overviewRows(loaded)
  }, [visibleRepos, data, failed])

  const columns = useMemo(() => {
    if (!selected) return null
    return groupByStatus(filterIssues(selected.issues, { query }))
  }, [selected, query])

  const shownCount = columns
    ? ISSUE_STATUSES.reduce((sum, status) => sum + columns[status].length, 0)
    : 0

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
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
        {repo && (
          <label className="flex h-7 items-center gap-1.5 border border-line bg-bg px-2 text-muted focus-within:border-line-active">
            <Search
              size={13}
              strokeWidth={1.8}
              className="shrink-0 text-subtle"
            />
            <input
              ref={filterRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter issues  ( / )"
              className="w-44 bg-transparent text-[12px] text-fg placeholder:text-subtle focus:outline-none"
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
        )}
        {/* Project chips: All (the overview) + one per repo. Board styling. */}
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => setRepo(null)}
            className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
              repo === null
                ? "border-line-active bg-inset text-fg"
                : "border-line text-subtle hover:text-fg"
            }`}
          >
            all
          </button>
          {visibleRepos.map((option) => {
            const state = data[option.repo]
            const openish = state
              ? state.issues.filter((issue) => issue.status !== "done").length
              : null
            return (
              <button
                key={option.repo}
                type="button"
                title={option.repo}
                onClick={() =>
                  setRepo(repo === option.repo ? null : option.repo)
                }
                className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                  repo === option.repo
                    ? "border-line-active bg-inset text-fg"
                    : "border-line text-subtle hover:text-fg"
                }`}
              >
                {option.label}
                {openish !== null && openish > 0 && (
                  <span
                    className={
                      repo === option.repo ? "text-muted" : "text-subtle"
                    }
                  >
                    {" "}
                    {openish}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {repo && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex items-center gap-1 border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
              title="New issue in this repo"
            >
              <Plus size={12} strokeWidth={2} />
              <span>New issue</span>
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              refresh(repo ? [repo] : visibleRepos.map((o) => o.repo))
            }
            disabled={loading}
            className="flex items-center text-muted transition-colors hover:text-fg disabled:opacity-40"
            aria-label="Refresh issues"
            title="Refresh issues"
          >
            <RefreshCw
              size={14}
              strokeWidth={1.8}
              className={loading ? "animate-spin" : ""}
            />
          </button>
          {repo && (
            <span className="font-mono text-[11px] text-subtle">
              {shownCount} issue{shownCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </header>

      {repo === null ? (
        /* ----- overview: per-repo summary cards --------------------------- */
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {!hydrated ? (
            <p className="text-[12px] text-subtle">Loading…</p>
          ) : visibleRepos.length === 0 ? (
            <p className="text-[12px] text-subtle">
              No git-backed projects with issues yet.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((row) => (
                <button
                  key={row.repoRoot}
                  type="button"
                  onClick={() => setRepo(row.repoRoot)}
                  title={row.repoRoot}
                  className="flex w-full flex-col gap-2 border border-line bg-surface p-3 text-left transition-colors hover:border-primary hover:bg-inset"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
                      {repoLabels.get(row.repoRoot) ?? row.repoRoot}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-subtle">
                      {row.total} total
                    </span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[10px]">
                    {ISSUE_STATUSES.map((status) => (
                      <span
                        key={status}
                        className={
                          row.counts[status] > 0
                            ? STATUS_META[status].accent
                            : "text-subtle"
                        }
                      >
                        {row.counts[status]} {status}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
              {visibleRepos
                .filter((option) => {
                  const state = data[option.repo]
                  return (state && !state.exists) || option.repo in failed
                })
                .map((option) => (
                  <button
                    key={option.repo}
                    type="button"
                    onClick={() => setRepo(option.repo)}
                    title={
                      failed[option.repo]
                        ? `${option.repo} — ${failed[option.repo]}`
                        : option.repo
                    }
                    className="flex w-full flex-col gap-2 border border-dashed border-line-subtle p-3 text-left transition-colors hover:border-line"
                  >
                    <span className="min-w-0 truncate text-[13px] text-muted">
                      {option.label}
                    </span>
                    <span className="text-[11px] text-subtle">
                      {failed[option.repo]
                        ? "failed to load issues"
                        : "no issues yet"}
                    </span>
                  </button>
                ))}
            </div>
          )}
        </div>
      ) : (
        /* ----- project view: 4 status columns ------------------------------ */
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
          {failed[repo] ? (
            <p className="text-[12px] text-kobe-red">
              Failed to load issues: {failed[repo]}
            </p>
          ) : !selected ? (
            <p className="text-[12px] text-subtle">Loading…</p>
          ) : (
            <div className="flex h-full min-w-max flex-col gap-2">
              {!selected.exists && (
                <p className="text-[11px] text-subtle">
                  This repo has no daemon issues yet — the first “New issue”
                  creates the tracker entry.
                </p>
              )}
              <div className="flex min-h-0 flex-1 gap-4">
                {ISSUE_STATUSES.map((status) => {
                  const issues = columns?.[status] ?? []
                  return (
                    <section
                      key={status}
                      className="flex h-full w-72 shrink-0 flex-col"
                    >
                      <div className="mb-2 flex items-baseline gap-2">
                        <h2
                          className={`text-[11px] font-bold uppercase tracking-[0.12em] ${STATUS_META[status].accent}`}
                        >
                          {STATUS_META[status].title}
                        </h2>
                        <span className="font-mono text-[10px] text-subtle">
                          {issues.length}
                        </span>
                      </div>
                      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
                        {issues.length === 0 ? (
                          <div className="border border-dashed border-line-subtle p-3 text-center text-[11px] text-subtle">
                            none
                          </div>
                        ) : (
                          issues.map((issue) => (
                            <IssueCard
                              key={issue.id}
                              issue={issue}
                              busy={mutating}
                              quickStartBusy={quickStartingId === issue.id}
                              onSetStatus={(to) =>
                                doSetStatus(repo, issue.id, to)
                              }
                              onQuickStart={() => doQuickStart(repo, issue)}
                              onOpen={() => setPeek({ repo, id: issue.id })}
                            />
                          ))
                        )}
                      </div>
                    </section>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {creating && repo && (
        <NewIssueDialog
          busy={mutating}
          onCreate={(title, body) => doCreate(repo, title, body)}
          onClose={() => setCreating(false)}
        />
      )}

      {repo && peekIssue && (
        <IssuePeek
          key={`${repo}:${peekIssue.id}`}
          issue={peekIssue}
          busy={mutating}
          quickStartBusy={quickStartingId === peekIssue.id}
          onClose={() => setPeek(null)}
          onSetStatus={(to) => doSetStatus(repo, peekIssue.id, to)}
          onQuickStart={() => doQuickStart(repo, peekIssue)}
          onSave={(patch) => doSave(repo, peekIssue.id, patch)}
        />
      )}
    </div>
  )
}
