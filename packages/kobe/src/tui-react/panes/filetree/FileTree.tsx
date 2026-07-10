/** @jsxImportSource @opentui/react */
/**
 * React file tree pane — the `src/tui/panes/filetree/FileTree.tsx`
 * counterpart (issue #15, G3). Same behavior, same shared framework-free
 * logic (`git.ts`, `rows.ts`, `pane-core.ts`, `keys-core.ts`,
 * `open-external.ts`); this file owns only the React reactivity, following
 * THE ASYNC CANON from `src/tui-react/history/host.tsx`:
 *
 *   - each async git read is `useState` + a dependency-keyed `useEffect`;
 *   - the last resolved value stays visible while a refresh is in flight;
 *   - stale completions are dropped (AbortController + fetch sequence);
 *   - the opt-in fs watch bumps a `refreshTick` scalar the data effect
 *     refetches from, instead of owning its own fetch.
 *
 * Solid→React prop delta: `worktreePath` / `focused` are plain values here
 * (React re-renders on prop change), not Accessors.
 *
 * Fetch-effect shape mirrors the Solid original 1:1 — three effects on
 * worktree change (wipe + reload), tab change (cache-first + cursor
 * reset), and refresh tick (cursor-preserving reload). Content-equality
 * setters (`sameFileList` / `sameStatusEntries`) keep no-change refreshes
 * from re-rendering, the same renderable-churn guard the Solid pane
 * carries (rows.ts has the memory-leak story).
 */

import { errorMessage } from "@/lib/error-message"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type StatusEntry, type TreeNode, buildTree, listFiles, statusFiles } from "../../../tui/panes/filetree/git"
import { type FileTreeTab, fileTreeBindings } from "../../../tui/panes/filetree/keys-core"
import { openExternally } from "../../../tui/panes/filetree/open-external"
import {
  type NavAction,
  collapseOrParentAction,
  computePathBudget,
  computeStatWidths,
  expandOrDescendAction,
  followScrollTop,
  summarizeGitError,
  toggleDir,
  watchWorktree,
} from "../../../tui/panes/filetree/pane-core"
import {
  type Row,
  flattenTree,
  reconcileRows,
  sameFileList,
  sameStatusEntries,
  statusRows,
} from "../../../tui/panes/filetree/rows"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { useBindings } from "../../lib/keymap"
import { useLatest } from "../../lib/use-latest"
import { FileTreeHeaderView } from "./header-view"
import { FileTreeRowView } from "./row-view"

/** Public props — the Solid `FileTreeProps` with plain values for the
 * reactive fields (see file header). Same field docs as the Solid pane. */
export type FileTreeProps = {
  /** Active task's worktree path; `null` renders the "No worktree" placeholder. */
  worktreePath: string | null
  /** Fires when the user activates a row (enter / click); worktree-relative path. */
  onOpenFile: (relPath: string) => void
  /** `a` — inject the current file as an `@<path>` mention (Ops host only). */
  onMention?: (relPath: string) => void
  /** `p` — request PR creation (Ops host only); also rendered as a chip. */
  onCreatePR?: () => void
  /** Zen-mode chip left of Create PR (enter-only, see the Solid pane doc). */
  onZenToggle?: () => void
  /** Whether the pane has keyboard focus. Defaults to `true`. */
  focused?: boolean
}

export function FileTree(props: FileTreeProps) {
  const { theme } = useTheme()
  const t = useT()
  // Pane width — in the Ops pane each FileTree runs in its own tmux pane
  // process, so `useTerminalDimensions` tracks THIS pane's size and reflows
  // the Changes-tab path truncation on resize.
  const dims = useTerminalDimensions()

  // ---------- pane state ----------
  const [tab, setTab] = useState<FileTreeTab>("all")
  const [cursorIndex, setCursorIndex] = useState(0)
  // Bumped by `r` (and the opt-in fs watch) to force a re-fetch.
  const [refreshTick, setRefreshTick] = useState(0)
  const [allFiles, setAllFiles] = useState<string[] | null>(null)
  const [changes, setChanges] = useState<StatusEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Expanded directory paths (worktree-relative). Reset on worktree change.
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(() => new Set())

  // Latest-render mirrors for effect bodies that must read a value without
  // depending on it (the Solid originals read these untracked inside `on(...)`).
  const pathRef = useLatest(props.worktreePath)
  const tabRef = useLatest(tab)
  const allFilesRef = useLatest(allFiles)
  const changesRef = useLatest(changes)
  const fetchSeq = useRef(0)

  /**
   * Fetch the data for a tab. Errors land in `error` and the row list goes
   * empty. The non-active tab's cache is wiped only on worktree change, not
   * on tab switch (cache-first tab pings). Content-equality functional
   * setters keep a no-change refresh from notifying downstream.
   */
  const refetch = useCallback(
    async (currentTab: FileTreeTab, path: string | null, signal?: AbortSignal): Promise<void> => {
      const seq = ++fetchSeq.current
      if (path == null) {
        setAllFiles(null)
        setChanges(null)
        setError(null)
        return
      }
      setError(null)
      try {
        if (currentTab === "all") {
          const files = await listFiles(path, signal)
          if (signal?.aborted || seq !== fetchSeq.current || pathRef.current !== path) return
          setAllFiles((prev) => (sameFileList(prev, files) ? prev : files))
        } else if (currentTab === "changes") {
          const entries = await statusFiles(path, signal)
          if (signal?.aborted || seq !== fetchSeq.current || pathRef.current !== path) return
          setChanges((prev) => (sameStatusEntries(prev, entries) ? prev : entries))
        }
      } catch (err) {
        // An aborted fetch (tab/worktree changed out from under us) throws
        // via the killed subprocess — swallow it, the next run owns state.
        if (signal?.aborted) return
        const message = errorMessage(err)
        if (seq === fetchSeq.current && pathRef.current === path) setError(message)
      }
    },
    [],
  )

  // Re-fetch when the worktree changes — wipe all caches first because the
  // old cache no longer applies. Cleanup aborts the in-flight git read so
  // rapid task-switches don't stack subprocesses.
  useEffect(() => {
    setAllFiles(null)
    setChanges(null)
    setError(null)
    setCursorIndex(0)
    setExpandedDirs(new Set<string>())
    const controller = new AbortController()
    void refetch(tabRef.current, props.worktreePath, controller.signal)
    return () => controller.abort()
  }, [props.worktreePath, refetch])

  // Realtime watch is opt-in (see watchWorktree) — the default path is
  // explicit refresh (`r`) plus tab/worktree changes.
  useEffect(() => {
    const path = props.worktreePath
    if (path == null) return
    if (process.env.KOBE_FILETREE_WATCH !== "1") return
    return watchWorktree(path, () => setRefreshTick((n) => n + 1))
  }, [props.worktreePath])

  // Re-fetch when the active TAB changes — cache-first, so pinging between
  // already-loaded tabs never respawns git. Resetting the cursor belongs
  // here (a different tab is a different list); a refresh of the SAME tab
  // must NOT yank the cursor to the top (that effect is below).
  useEffect(() => {
    setCursorIndex(0)
    const path = pathRef.current
    if (path == null) return
    const controller = new AbortController()
    if (tab === "all") {
      if (allFilesRef.current == null) void refetch("all", path, controller.signal)
    } else if (tab === "changes") {
      if (changesRef.current == null) void refetch("changes", path, controller.signal)
    }
    return () => controller.abort()
  }, [tab, refetch])

  // Re-fetch on a real refresh tick (`r` or a debounced fs-watch event).
  // Tick 0 is the mount value — the worktree effect already did the first
  // fetch. Unlike a tab switch, a refresh PRESERVES the cursor (the clamp
  // effect below pulls it back only if the row count shrank past it).
  useEffect(() => {
    if (refreshTick === 0) return
    const path = pathRef.current
    if (path == null) return
    const controller = new AbortController()
    void refetch(tabRef.current, path, controller.signal)
    return () => controller.abort()
  }, [refreshTick, refetch])

  // Tree built once per `allFiles` change and reused while expansion
  // state mutates — flattening below is O(visible-rows).
  const tree = useMemo<TreeNode | null>(() => (allFiles == null ? null : buildTree(allFiles)), [allFiles])

  // Derived rows, reconciled against the previous list so unchanged rows
  // keep object identity (stable React keys + reference-equal memo output
  // when nothing changed — same renderable-reuse story as the Solid pane).
  const prevRows = useRef<readonly Row[]>([])
  const rows = useMemo<readonly Row[]>(() => {
    const next: Row[] = []
    if (tab === "all") {
      if (tree != null) flattenTree(tree, expandedDirs, 0, next)
    } else if (tab === "changes") {
      if (changes != null) next.push(...statusRows(changes))
    }
    const reconciled = reconcileRows(prevRows.current, next)
    prevRows.current = reconciled
    return reconciled
  }, [tab, tree, expandedDirs, changes])

  // Keep the cursor in range when a refresh shrinks the list. Tab switches
  // already reset the cursor to 0; this only clamps a preserved cursor that
  // now points past the end.
  useEffect(() => {
    if (rows.length === 0) return
    setCursorIndex((i) => (i > rows.length - 1 ? rows.length - 1 : i))
  }, [rows])

  const statWidths = useMemo(() => computeStatWidths(rows), [rows])
  const pathBudget = useMemo(() => computePathBudget(dims.width, statWidths), [dims.width, statWidths])

  // ---------- key bindings ----------
  function applyNav(action: NavAction | null): void {
    if (!action) return
    if (action.type === "cursor") setCursorIndex(action.index)
    else if (action.type === "expand") setExpandedDirs((prev) => new Set(prev).add(action.path))
    else setExpandedDirs((prev) => toggleDir(prev, action.path))
  }

  /** Shared enter/click activation: dirs toggle, files open. */
  function activateRow(row: Row): void {
    if (row.kind === "dir") setExpandedDirs((prev) => toggleDir(prev, row.path))
    else props.onOpenFile(row.path)
  }

  // `useBindings` re-reads the config per keypress through a render-refreshed
  // ref, so these closures always see the latest rows/cursor/tab.
  useBindings(() => ({
    enabled: props.focused ?? true,
    bindings: fileTreeBindings({
      moveDown: () => {
        if (rows.length === 0) return
        setCursorIndex((i) => Math.min(i + 1, rows.length - 1))
      },
      moveUp: () => {
        if (rows.length === 0) return
        setCursorIndex((i) => Math.max(i - 1, 0))
      },
      setTab,
      currentTab: () => tab,
      openCurrent: () => {
        const row = rows[cursorIndex]
        if (row) activateRow(row)
      },
      mentionCurrent: () => {
        const row = rows[cursorIndex]
        // Only files make sense as an @mention; dirs are ignored.
        if (!row || row.kind === "dir") return
        props.onMention?.(row.path)
      },
      createPR: props.onCreatePR,
      openExternal: () => {
        const row = rows[cursorIndex]
        if (!row || row.kind === "dir") return
        if (!props.worktreePath) return
        openExternally(`${props.worktreePath}/${row.path}`)
      },
      refresh: () => {
        setRefreshTick((n) => n + 1)
      },
      expandOrDescend: () => applyNav(expandOrDescendAction(rows, cursorIndex)),
      collapseOrParent: () => {
        if (tab !== "all") return
        applyNav(collapseOrParentAction(rows, cursorIndex))
      },
    }),
  }))

  // ---------- viewport follow ----------
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || rows.length === 0) return
    const y = followScrollTop(scroll.scrollTop, scroll.viewport.height, cursorIndex)
    if (y != null) scroll.scrollTo({ x: 0, y })
  }, [cursorIndex, rows])

  // ---------- render ----------
  const loaded = (tab === "all" && allFiles != null) || (tab === "changes" && changes != null)
  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingBottom={1} paddingLeft={0} paddingRight={0}>
      <FileTreeHeaderView
        tab={tab}
        onSelectTab={setTab}
        onZenToggle={props.onZenToggle}
        onCreatePR={props.onCreatePR}
      />

      {/* Body: scrollable list. Track + thumb both transparent → invisible
         by default but still scrollable. */}
      <scrollbox
        ref={(r: ScrollBoxRenderable | null) => {
          scrollRef.current = r
        }}
        flexGrow={1}
        verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
      >
        {props.worktreePath == null ? (
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>{t("files.empty.noTask")}</text>
          </box>
        ) : error != null ? (
          <box paddingTop={1} paddingLeft={1} flexDirection="column" gap={0}>
            <text fg={theme.error} wrapMode="word">
              {summarizeGitError(error, t)}
            </text>
            <text fg={theme.textMuted} wrapMode="word">
              {t("files.error.retryHint")}
            </text>
          </box>
        ) : rows.length === 0 && loaded ? (
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>{tab === "all" ? t("files.empty.noFiles") : t("files.empty.noChanges")}</text>
          </box>
        ) : rows.length > 0 ? (
          <box flexShrink={0} gap={0} paddingRight={1}>
            {rows.map((row, index) => (
              <FileTreeRowView
                key={`${row.kind}:${row.path}`}
                row={row}
                cursor={index === cursorIndex}
                statWidths={statWidths}
                pathBudget={pathBudget}
                onActivate={() => {
                  setCursorIndex(index)
                  activateRow(row)
                }}
              />
            ))}
          </box>
        ) : null}
      </scrollbox>

      {/* Footer hint — shown only when a worktree is loaded so the
         "no task" placeholder stays clean. */}
      {props.worktreePath != null ? (
        <box flexDirection="row" paddingTop={1} flexShrink={0}>
          <text fg={theme.textMuted} wrapMode="none">
            {t("files.footer.openHint")}
          </text>
        </box>
      ) : null}
    </box>
  )
}
