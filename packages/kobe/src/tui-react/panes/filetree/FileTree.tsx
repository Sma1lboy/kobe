/** @jsxImportSource @opentui/react */

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
import { FileTreeHeaderView } from "./header-view"
import { FileTreeRowView } from "./row-view"

export type FileTreeProps = {
  worktreePath: string | null
  onOpenFile: (relPath: string) => void
  onMention?: (relPath: string) => void
  onCreatePR?: () => void
  onZenToggle?: () => void
  focused?: boolean
  cornerBadge?: { text: string; active: boolean } | null
  onRefresh?: () => void
}

export function FileTree(props: FileTreeProps) {
  const { theme } = useTheme()
  const t = useT()
  const dims = useTerminalDimensions()

  const [tab, setTab] = useState<FileTreeTab>("all")
  const [cursorIndex, setCursorIndex] = useState(0)
  const [refreshTick, setRefreshTick] = useState(0)
  const [allFiles, setAllFiles] = useState<string[] | null>(null)
  const [changes, setChanges] = useState<StatusEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(() => new Set())

  const pathRef = useRef(props.worktreePath)
  pathRef.current = props.worktreePath
  const tabRef = useRef(tab)
  tabRef.current = tab
  const allFilesRef = useRef(allFiles)
  allFilesRef.current = allFiles
  const changesRef = useRef(changes)
  changesRef.current = changes
  const fetchSeq = useRef(0)

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
        if (signal?.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        if (seq === fetchSeq.current && pathRef.current === path) setError(message)
      }
    },
    [],
  )

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

  useEffect(() => {
    const path = props.worktreePath
    if (path == null) return
    if (process.env.KOBE_FILETREE_WATCH !== "1") return
    return watchWorktree(path, () => setRefreshTick((n) => n + 1))
  }, [props.worktreePath])

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

  useEffect(() => {
    if (refreshTick === 0) return
    const path = pathRef.current
    if (path == null) return
    const controller = new AbortController()
    void refetch(tabRef.current, path, controller.signal)
    return () => controller.abort()
  }, [refreshTick, refetch])

  const tree = useMemo<TreeNode | null>(() => (allFiles == null ? null : buildTree(allFiles)), [allFiles])

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

  useEffect(() => {
    if (rows.length === 0) return
    setCursorIndex((i) => (i > rows.length - 1 ? rows.length - 1 : i))
  }, [rows])

  const statWidths = useMemo(() => computeStatWidths(rows), [rows])
  const pathBudget = useMemo(() => computePathBudget(dims.width, statWidths), [dims.width, statWidths])

  function applyNav(action: NavAction | null): void {
    if (!action) return
    if (action.type === "cursor") setCursorIndex(action.index)
    else if (action.type === "expand") setExpandedDirs((prev) => new Set(prev).add(action.path))
    else setExpandedDirs((prev) => toggleDir(prev, action.path))
  }

  function activateRow(row: Row): void {
    if (row.kind === "dir") setExpandedDirs((prev) => toggleDir(prev, row.path))
    else props.onOpenFile(row.path)
  }

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
        props.onRefresh?.()
      },
      expandOrDescend: () => applyNav(expandOrDescendAction(rows, cursorIndex)),
      collapseOrParent: () => {
        if (tab !== "all") return
        applyNav(collapseOrParentAction(rows, cursorIndex))
      },
    }),
  }))

  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || rows.length === 0) return
    const y = followScrollTop(scroll.scrollTop, scroll.viewport.height, cursorIndex)
    if (y != null) scroll.scrollTo({ x: 0, y })
  }, [cursorIndex, rows])

  const loaded = (tab === "all" && allFiles != null) || (tab === "changes" && changes != null)
  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingBottom={1} paddingLeft={0} paddingRight={0}>
      <FileTreeHeaderView
        tab={tab}
        onSelectTab={setTab}
        cornerBadge={props.cornerBadge ?? null}
        onZenToggle={props.onZenToggle}
        onCreatePR={props.onCreatePR}
      />

      {}
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

      {}
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
