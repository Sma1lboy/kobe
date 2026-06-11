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
import { loadPromptPreview, usePromptPreviews } from "../lib/prompt-preview.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { selectTask } from "../lib/tabs.ts"
import { matchesTask } from "../lib/task-list.ts"
import { relativeTime } from "../lib/time.ts"
import { type Bucket, triage } from "../lib/triage.ts"
import type { EngineState, Task, WorktreeChangeCounts } from "../lib/types.ts"
import { PrChip } from "./PrChip.tsx"

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
  onOpen,
}: {
  entry: TriagedTask
  preview: string | null | undefined
  onOpen: () => void
}) {
  const { task, engine, changes } = entry
  const label = activityLabel(engine?.state)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 border border-line bg-surface p-3 text-left transition-colors hover:border-primary hover:bg-inset"
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityColor(engine?.state)}`}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
          {task.title || task.branch || task.id}
        </span>
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
          {label && <span className="text-muted">{label}</span>}
          <span>{relativeTime(task.updatedAt || task.createdAt)}</span>
        </span>
      </div>
    </button>
  )
}

export function Overview() {
  const { tasks, engineStates, worktreeChanges, hydrated } = useAppState()
  const navigate = useNavigate()
  const previews = usePromptPreviews()
  const [query, setQuery] = useState("")
  const filterRef = useRef<HTMLInputElement>(null)

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

  // Keyboard-first parity with the rail: `/` focuses the filter, Escape clears
  // it. Suppressed while typing in another field.
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
  }, [query])

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

  const open = (id: string): void => {
    selectTask(id)
    void rpc("task.setActive", { taskId: id }).catch(() => {})
    void navigate({ to: "/task/$taskId", params: { taskId: id } })
  }

  const counts = {
    attention: byBucket.attention.length,
    working: byBucket.working.length,
    changes: byBucket.changes.length,
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
