/**
 * Overview — mission control for running many sessions at once. Triages every
 * task into attention buckets (needs you / working / has changes / quiet) so
 * you can see, across all tasks, which ones want your attention right now and
 * jump straight to them. The view kobe's "many parallel agents" value prop
 * actually needs.
 */

import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { activityColor, activityLabel } from "../lib/activity.ts"
import {
  conflictBadge,
  conflictTip,
  provenConflictCount,
} from "../lib/board.ts"
import { engineLabel, useEngines } from "../lib/engines.ts"
import { moveHighlight, reconcileHighlight } from "../lib/overview-nav.ts"
import { loadPromptPreview, usePromptPreviews } from "../lib/prompt-preview.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import { isMixedEngineWorkspace, matchesTask } from "../lib/task-list.ts"
import { relativeTime } from "../lib/time.ts"
import { type Bucket, triage } from "../lib/triage.ts"
import type { EngineState, Task, WorktreeChangeCounts } from "../lib/types.ts"
import { ConflictChip, EngineChip, PrChip } from "./chips.tsx"

interface TriagedTask {
  task: Task
  engine?: EngineState
  changes?: { added: number; deleted: number }
  bucket: Bucket
}

const BUCKETS: Array<{
  key: Bucket
  title: string
  hint: string
  accent: string
}> = [
  {
    key: "attention",
    title: "Needs you",
    hint: "waiting on input, rate-limited, or errored",
    accent: "text-kobe-blue",
  },
  {
    key: "working",
    title: "Working",
    hint: "engine is running right now",
    accent: "text-kobe-orange",
  },
  {
    key: "changes",
    title: "Uncommitted changes",
    hint: "idle with a dirty worktree",
    accent: "text-kobe-green",
  },
  { key: "quiet", title: "Quiet", hint: "idle, clean", accent: "text-subtle" },
]

function Card({
  entry,
  preview,
  conflict,
  engineName,
  highlighted,
  onOpen,
}: {
  entry: TriagedTask
  preview: string | null | undefined
  conflict: { level: "overlap" | "conflict"; count: number; tip: string } | null
  /** Engine label to show (mixed-engine workspaces only); null hides it. */
  engineName: string | null
  highlighted: boolean
  onOpen: () => void
}) {
  const { task, engine, changes } = entry
  const label = activityLabel(engine?.state)
  return (
    <button
      type="button"
      data-overview-card={task.id}
      onClick={onOpen}
      className={`flex w-full flex-col gap-1.5 border bg-surface p-3 text-left transition-colors hover:border-primary hover:bg-inset ${
        highlighted ? "border-primary bg-inset" : "border-line"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityColor(engine?.state)}`}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
          {task.title || task.branch || task.id}
        </span>
        <ConflictChip badge={conflict} />
        <PrChip pr={task.prStatus} />
        {changes && (changes.added > 0 || changes.deleted > 0) && (
          <span className="shrink-0 font-mono text-[10px]">
            <span className="text-kobe-green">+{changes.added}</span>{" "}
            <span className="text-kobe-red">−{changes.deleted}</span>
          </span>
        )}
      </div>
      {preview && (
        <div
          className="flex items-baseline gap-1.5 text-[11px] text-muted"
          title={preview}
        >
          <span className="shrink-0 font-mono text-subtle">❯</span>
          <span className="min-w-0 truncate">{preview}</span>
        </div>
      )}
      <div className="flex items-center gap-2 text-[11px] text-subtle">
        <span className="min-w-0 truncate font-mono">
          {task.branch || task.repo}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <EngineChip label={engineName} />
          {label && <span className="text-muted">{label}</span>}
          <span>{relativeTime(task.updatedAt || task.createdAt)}</span>
        </span>
      </div>
    </button>
  )
}

export function Overview() {
  const { tasks, engineStates, worktreeChanges, conflicts, hydrated } =
    useAppState()
  const navigate = useNavigate()
  const previews = usePromptPreviews()
  // Engine label per card — only when the workspace runs mixed engines (else
  // it's the same word on every card). Engine-owned label, pure mixed check.
  const engines = useEngines()
  const mixedEngines = useMemo(
    () => isMixedEngineWorkspace(tasks as Task[]),
    [tasks],
  )
  const [query, setQuery] = useState("")
  const filterRef = useRef<HTMLInputElement>(null)

  // Conflict radar (daemon-collected, shared with the board): a task that
  // truly collides with another in-flight task gets a ⚠ badge here too —
  // a merge conflict is exactly the kind of thing the triage view exists to
  // surface. Same badge summary + tooltip text as the board (lib/board.ts).
  const conflictByTask = useMemo(() => {
    const titleOf = (id: string): string => {
      const t = (tasks as Task[]).find((task) => task.id === id)
      return t?.title || t?.branch || id
    }
    const map = new Map<
      string,
      { level: "overlap" | "conflict"; count: number; tip: string }
    >()
    for (const id of new Set(conflicts.flatMap((p) => [p.a, p.b]))) {
      const summary = conflictBadge(conflicts, id)
      if (summary)
        map.set(id, { ...summary, tip: conflictTip(conflicts, id, titleOf) })
    }
    return map
  }, [conflicts, tasks])

  // Refresh previews on task-list changes AND engine activity. The second
  // trigger is load-bearing: a prompt/turn publishes only on the engine-state
  // channel and never bumps the tasks identity, so without it the previews
  // would freeze while Overview sits open. mtime-gated inside the store, so a
  // re-run is one cheap sessions call per task, no message re-downloads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: engineStates is a deliberate re-trigger, not a read — engine transitions mark "transcript advanced" without changing tasks identity.
  useEffect(() => {
    for (const task of tasks as Task[]) {
      if (task.archived || task.kind === "main") continue
      void loadPromptPreview(task)
    }
  }, [tasks, engineStates])

  const triaged = useMemo<TriagedTask[]>(() => {
    return (tasks as Task[])
      .filter((t) => !t.archived && t.kind !== "main")
      .map((task) => {
        const engine = engineStates[task.id]
        const changes = (worktreeChanges as WorktreeChangeCounts)[
          task.worktreePath
        ]
        return { task, engine, changes, bucket: triage(engine, changes) }
      })
  }, [tasks, engineStates, worktreeChanges])

  const shown = useMemo(
    () => triaged.filter((e) => matchesTask(e.task, query)),
    [triaged, query],
  )

  const byBucket = useMemo(() => {
    const map: Record<Bucket, TriagedTask[]> = {
      attention: [],
      working: [],
      changes: [],
      quiet: [],
    }
    for (const entry of shown) map[entry.bucket].push(entry)
    return map
  }, [shown])

  // The keyboard path through the grid: bucket by bucket, displayed order.
  const order = useMemo(
    () => BUCKETS.flatMap(({ key }) => byBucket[key].map((e) => e.task.id)),
    [byBucket],
  )
  const [highlighted, setHighlighted] = useState<string | null>(null)

  // Filtering or a bucket move can drop the highlighted card — clear the
  // highlight then (reconcileHighlight returns the same value when shown,
  // so this setState is a no-op render-wise in the common case).
  useEffect(() => {
    setHighlighted((current) => reconcileHighlight(order, current))
  }, [order])

  // Keep the highlighted card visible while j/k walks past the fold.
  useEffect(() => {
    if (!highlighted) return
    document
      .querySelector(`[data-overview-card="${CSS.escape(highlighted)}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [highlighted])

  const open = (id: string): void => {
    selectTask(id)
    void rpc("task.setActive", { taskId: id }).catch(() => {})
    void navigate({ to: "/task/$taskId", params: { taskId: id } })
  }

  // Keyboard-first parity with the rail: `/` focuses the filter, Escape clears
  // it, j/k (or arrows) walk a highlight through the grid, Enter opens the
  // highlighted card. Unlike the rail's j/k (which switches the active task
  // live), the highlight is local — browsing never navigates mid-scan.
  // Suppressed while typing in a field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open() closes only over stable refs (mirrors the rail's nav effect); query/order/highlighted are the real re-arm triggers.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const t = event.target as HTMLElement | null
      const inField =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      const down = event.key === "j" || event.key === "ArrowDown"
      const up = event.key === "k" || event.key === "ArrowUp"
      if (event.key === "/" && !inField) {
        event.preventDefault()
        filterRef.current?.focus()
      } else if (event.key === "Escape" && t === filterRef.current && query) {
        event.preventDefault()
        setQuery("")
      } else if ((down || up) && !inField) {
        if (order.length === 0) return
        event.preventDefault()
        setHighlighted((current) =>
          moveHighlight(order, current, down ? 1 : -1),
        )
      } else if (event.key === "Enter" && !inField && highlighted) {
        // A focused button/link keeps its native Enter activation (Tab to a
        // card or the back button must work) — the highlight owns Enter only
        // when nothing interactive has focus.
        if (t?.closest("button,a,[role=button]")) return
        event.preventDefault()
        open(highlighted)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [query, order, highlighted])

  const counts = {
    attention: byBucket.attention.length,
    working: byBucket.working.length,
    changes: byBucket.changes.length,
    // Proven merge conflicts among the shown tasks (overlaps stay per-card).
    conflicts: provenConflictCount(
      conflicts,
      shown.map((e) => e.task.id),
    ),
  }

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
          Overview
        </span>
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
            onKeyDown={(event) => {
              // Keyboard-first parity with the rail's filter: Enter jumps to
              // the top match (first card of the bucket walk — "needs you"
              // first), then blurs so j/k resume on the grid.
              if (event.key === "Enter" && order.length > 0) {
                event.preventDefault()
                open(order[0])
                event.currentTarget.blur()
              }
            }}
            placeholder="Filter tasks  ( / )"
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
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px]">
          <span className="text-kobe-blue">{counts.attention} need input</span>
          <span className="text-kobe-orange">{counts.working} running</span>
          <span className="text-kobe-green">{counts.changes} dirty</span>
          {counts.conflicts > 0 && (
            <span className="text-kobe-red">
              {counts.conflicts} conflicting
            </span>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!hydrated ? (
          <p className="text-[12px] text-subtle">Loading…</p>
        ) : triaged.length === 0 ? (
          <p className="text-[12px] text-subtle">
            No worktree tasks yet. Create one from the workspace.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-[12px] text-subtle">
            No tasks match “{query.trim()}”.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {BUCKETS.map(({ key, title, hint, accent }) => {
              const entries = byBucket[key]
              return (
                <section key={key} className="flex min-w-0 flex-col">
                  <div className="mb-2 flex items-baseline gap-2">
                    <h2
                      className={`text-[11px] font-bold uppercase tracking-[0.12em] ${accent}`}
                    >
                      {title}
                    </h2>
                    <span className="font-mono text-[10px] text-subtle">
                      {entries.length}
                    </span>
                  </div>
                  <p className="mb-2 text-[10px] leading-relaxed text-subtle">
                    {hint}
                  </p>
                  <div className="flex flex-col gap-2">
                    {entries.length === 0 ? (
                      <div className="border border-dashed border-line-subtle p-3 text-center text-[11px] text-subtle">
                        none
                      </div>
                    ) : (
                      entries.map((entry) => (
                        <Card
                          key={entry.task.id}
                          entry={entry}
                          preview={previews[entry.task.id]}
                          conflict={conflictByTask.get(entry.task.id) ?? null}
                          engineName={
                            mixedEngines
                              ? engineLabel(engines, entry.task.vendor)
                              : null
                          }
                          highlighted={entry.task.id === highlighted}
                          onOpen={() => open(entry.task.id)}
                        />
                      ))
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
