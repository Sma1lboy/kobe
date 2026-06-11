/**
 * DiffView — the web CHANGES pane.
 *
 * Shows the git working-tree changes of a task's worktree: a file list (left)
 * + the selected file's unified diff (main), with per-line +/- coloring from
 * the claude theme. Read-only; re-fetches when worktreePath changes, on a
 * manual refresh, and LIVE whenever the daemon's worktree.changes counts for
 * this worktree move (the agent edits → daemon collector ticks → counts
 * change → we refetch; no browser-side git polling).
 *
 * Mount note: render <DiffView worktreePath={activeTask?.worktreePath ?? null} />
 * — the lead wires the active task's worktreePath in (e.g. in AppShell's
 * ToolsPane region).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type DiffFile, type DiffResult, fetchDiff } from "../lib/diff.ts"
import { rowClass, statusBadge } from "../lib/diff-display.ts"
import { filterDiffFiles } from "../lib/diff-filter.ts"
import { diffStat, parseDiffRows } from "../lib/diff-rows.ts"
import { tailPath } from "../lib/path-format.ts"
import { useAppState } from "../lib/store.ts"
import "./diff-view.css"

/** `+a −d` chip; renders nothing when both are zero. */
function StatChip({ added, deleted }: { added: number; deleted: number }) {
  if (added === 0 && deleted === 0) return null
  return (
    <span className="shrink-0 font-mono text-[10px]">
      <span className="text-kobe-green">+{added}</span>{" "}
      <span className="text-kobe-red">−{deleted}</span>
    </span>
  )
}

/** Stable refresh key for a worktree's daemon-collected change counts —
 *  changes exactly when the +N/−M pair moves, which is the refetch signal. */
function useChangesKey(worktreePath: string | null): string {
  const { worktreeChanges } = useAppState()
  const counts = worktreePath ? worktreeChanges[worktreePath] : undefined
  return counts ? `${counts.added}:${counts.deleted}` : "none"
}

/** Render a parsed unified diff into the gutter+text row grid. `wrap` soft-wraps
 *  long lines instead of the default horizontal scroll. */
export function DiffBody({ patch, wrap }: { patch: string; wrap?: boolean }) {
  const rows = useMemo(() => parseDiffRows(patch), [patch])
  if (!patch.trim()) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-subtle">
        No textual diff for this file.
      </div>
    )
  }
  return (
    <div
      className={`kobe-diff min-h-0 flex-1 overflow-auto py-2 font-mono text-[12px] leading-[1.15rem] ${wrap ? "kobe-diff-wrap" : ""}`}
    >
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional and re-rendered wholesale per file
        <div key={i} className={`kobe-diff-row ${rowClass(row.kind)}`}>
          <span className="kobe-diff-gutter">{row.oldLn ?? ""}</span>
          <span className="kobe-diff-gutter">{row.newLn ?? ""}</span>
          <span className="kobe-diff-text">
            {row.text === "" ? " " : row.text}
          </span>
        </div>
      ))}
    </div>
  )
}

function FileList({
  files,
  selected,
  onSelect,
}: {
  files: DiffFile[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  return (
    <div className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-line">
      {files.map((f) => {
        const badge = statusBadge(f.status)
        const active = f.path === selected
        return (
          <button
            key={f.path}
            type="button"
            onClick={() => onSelect(f.path)}
            title={f.path}
            className={`flex items-center gap-2 border-l-2 px-2 py-1.5 text-left transition-colors ${
              active
                ? "border-primary bg-inset"
                : "border-transparent hover:bg-surface"
            }`}
          >
            <span
              className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${badge.cls}`}
            >
              {badge.label}
            </span>
            <span
              className={`truncate text-[12px] ${active ? "text-fg" : "text-fg/90"}`}
            >
              {tailPath(f.path, 28)}
            </span>
            {f.staged && (
              <span className="ml-auto shrink-0 text-[9px] uppercase text-subtle">
                staged
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function DiffView({ worktreePath }: { worktreePath: string | null }) {
  const [result, setResult] = useState<DiffResult | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changesKey = useChangesKey(worktreePath)

  const load = useCallback(async () => {
    if (!worktreePath) {
      setResult(null)
      setSelected(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await fetchDiff(worktreePath)
      setResult(data)
      // Keep the current selection if it still exists, else pick the first file.
      setSelected((prev) => {
        if (prev && data.files.some((f) => f.path === prev)) return prev
        return data.files[0]?.path ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setResult(null)
    } finally {
      setLoading(false)
    }
  }, [worktreePath])

  // biome-ignore lint/correctness/useExhaustiveDependencies: changesKey is the live-refresh trigger, not a read dependency.
  useEffect(() => {
    void load()
  }, [load, changesKey])

  const files = result?.files ?? []
  const current = files.find((f) => f.path === selected) ?? null
  const total = useMemo(() => {
    let added = 0
    let deleted = 0
    for (const f of files) {
      const s = diffStat(f.patch)
      added += s.added
      deleted += s.deleted
    }
    return { added, deleted }
  }, [files])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
          Changes{files.length > 0 ? ` · ${files.length}` : ""}
        </span>
        <StatChip added={total.added} deleted={total.deleted} />
        <button
          type="button"
          onClick={() => void load()}
          disabled={!worktreePath || loading}
          className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface disabled:opacity-40"
        >
          {loading ? "…" : "↻ refresh"}
        </button>
      </div>

      {!worktreePath ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <div>
            <div className="text-[12px] font-semibold text-fg">
              No worktree selected
            </div>
            <div className="mt-1 max-w-56 text-[12px] leading-relaxed text-subtle">
              Pick a task to inspect its current diff.
            </div>
          </div>
        </div>
      ) : error ? (
        <div className="px-3 py-4 text-[12px] leading-relaxed text-kobe-red">
          {error}
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[12px] text-subtle">
          {loading ? "Loading changes…" : "No changes in this worktree."}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <FileList files={files} selected={selected} onSelect={setSelected} />
          <div className="flex min-w-0 flex-1 flex-col">
            {current && (
              <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
                <span
                  className="truncate font-mono text-[11px] text-fg"
                  title={current.path}
                >
                  {current.path}
                </span>
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-subtle">
                  {current.status}
                </span>
              </div>
            )}
            {current ? (
              <DiffBody patch={current.patch} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-[12px] text-subtle">
                Select a file.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function ChangesList({
  worktreePath,
  onOpenFile,
}: {
  worktreePath: string | null
  onOpenFile: (path: string) => void
}) {
  const [result, setResult] = useState<DiffResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changesKey = useChangesKey(worktreePath)
  // The list is names-only (no patches), so per-file counts aren't available
  // here — show the daemon's worktree total instead.
  const { worktreeChanges } = useAppState()
  const wtTotal = worktreePath ? worktreeChanges[worktreePath] : undefined

  // Out-of-order guard: a fast task switch (or refresh spam) fires overlapping
  // fetches; only the most recent may write state, else a late response for the
  // previous worktree clobbers the current one's file list.
  const seqRef = useRef(0)
  const load = useCallback(async () => {
    if (!worktreePath) {
      setResult(null)
      setError(null)
      return
    }
    const seq = ++seqRef.current
    setLoading(true)
    setError(null)
    try {
      // The list renders only names + badges, so skip per-file patch assembly.
      const data = await fetchDiff(worktreePath, { namesOnly: true })
      if (seq === seqRef.current) setResult(data)
    } catch (err) {
      if (seq === seqRef.current) {
        setError(err instanceof Error ? err.message : String(err))
        setResult(null)
      }
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [worktreePath])

  // biome-ignore lint/correctness/useExhaustiveDependencies: changesKey is the live-refresh trigger, not a read dependency.
  useEffect(() => {
    void load()
  }, [load, changesKey])

  const [filter, setFilter] = useState("")
  // Clear the filter on task switch — a query for one worktree's paths is
  // meaningless in another. (Not on changesKey: a live refresh of the SAME
  // worktree must keep what the user typed.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on worktreePath only, by design.
  useEffect(() => {
    setFilter("")
  }, [worktreePath])

  const files = result?.files ?? []
  const shown = useMemo(() => filterDiffFiles(files, filter), [files, filter])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
          Changes{files.length > 0 ? ` · ${files.length}` : ""}
        </span>
        {wtTotal && (
          <StatChip added={wtTotal.added} deleted={wtTotal.deleted} />
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={!worktreePath || loading}
          className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface disabled:opacity-40"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      {!worktreePath ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <div>
            <div className="text-[12px] font-semibold text-fg">
              No task selected
            </div>
            <div className="mt-1 max-w-48 text-[12px] leading-relaxed text-subtle">
              Select a task to watch its worktree changes.
            </div>
          </div>
        </div>
      ) : error ? (
        <div className="px-3 py-4 text-[12px] leading-relaxed text-kobe-red">
          {error}
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <div className="text-[12px] text-subtle">
            {loading ? "Loading changes…" : "Worktree clean."}
          </div>
        </div>
      ) : (
        <>
          {files.length > 1 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${files.length} files…`}
              spellCheck={false}
              className="mx-3 mb-1 shrink-0 border border-line bg-bg px-2 py-1 font-mono text-[11px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
            />
          )}
          {shown.length === 0 ? (
            <div className="px-3 py-3 text-center text-[11px] text-subtle">
              No files match.
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {shown.map((f) => {
                const badge = statusBadge(f.status)
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => onOpenFile(f.path)}
                    title={f.path}
                    className="flex w-full items-center gap-2 border-l-2 border-transparent px-3 py-2 text-left transition-colors hover:border-primary hover:bg-inset"
                  >
                    <span
                      className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${badge.cls}`}
                    >
                      {badge.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-fg/90">
                      {tailPath(f.path, 34)}
                    </span>
                    {f.staged && (
                      <span className="shrink-0 text-[9px] uppercase text-subtle">
                        staged
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function FilePreview({
  worktreePath,
  path,
}: {
  worktreePath: string | null
  path: string
}) {
  const [file, setFile] = useState<DiffFile | null>(null)
  const [wrap, setWrap] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changesKey = useChangesKey(worktreePath)

  // biome-ignore lint/correctness/useExhaustiveDependencies: changesKey re-fetches the patch when the worktree's counts move.
  useEffect(() => {
    if (!worktreePath) {
      setFile(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    // Ask for just this file's patch instead of the whole worktree's diff set.
    void fetchDiff(worktreePath, { path })
      .then((result) => {
        if (cancelled) return
        setFile(result.files.find((item) => item.path === path) ?? null)
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [worktreePath, path, changesKey])

  const stat = file ? diffStat(file.patch) : null
  return (
    <div className="flex h-full min-h-0 flex-col border border-line bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="truncate font-mono text-[12px] text-fg" title={path}>
          {path}
        </span>
        {stat && (
          <span className="ml-auto shrink-0">
            <StatChip added={stat.added} deleted={stat.deleted} />
          </span>
        )}
        {file && (
          <span
            className={`shrink-0 text-[10px] uppercase tracking-wide text-subtle ${stat && (stat.added || stat.deleted) ? "" : "ml-auto"}`}
          >
            {file.status}
          </span>
        )}
        {file && (
          <button
            type="button"
            onClick={() => setWrap((v) => !v)}
            title={wrap ? "Disable line wrap" : "Wrap long lines"}
            className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
              wrap
                ? "border-primary bg-inset text-fg"
                : "border-line bg-bg text-subtle hover:border-primary hover:text-fg"
            }`}
          >
            wrap
          </button>
        )}
      </div>
      {error ? (
        <div className="px-3 py-4 text-[12px] leading-relaxed text-kobe-red">
          {error}
        </div>
      ) : file ? (
        // Keep the previous patch on screen during a live refetch — a count
        // tick must not flash the view back to a loading state.
        <DiffBody patch={file.patch} wrap={wrap} />
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-subtle">
          Loading preview…
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-[12px] text-subtle">
          No diff for this file.
        </div>
      )}
    </div>
  )
}
