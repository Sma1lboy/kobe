import { t } from "@/tui/i18n"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import { type StatusEntry, type TreeNode, buildTree, listFiles, statusFiles } from "./git"
import { FileTreeHeaderView } from "./header-view"
import { type FileTreeTab, useFileTreeBindings } from "./keys"
import { openExternally } from "./open-external"
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
} from "./pane-core"
import { FileTreeRowView } from "./row-view"
import { type Row, flattenTree, reconcileRows, sameFileList, sameStatusEntries, statusRows } from "./rows"

export const FILETREE_WIDTH = 38

export type FileTreeProps = {
  worktreePath: Accessor<string | null>
  onOpenFile: (relPath: string) => void
  onMention?: (relPath: string) => void
  onCreatePR?: () => void
  onZenToggle?: () => void
  focused?: Accessor<boolean>
  cornerBadge?: Accessor<{ text: string; active: boolean } | null>
  onRefresh?: () => void
}

export function FileTree(props: FileTreeProps) {
  const { theme } = useTheme()

  const dims = useTerminalDimensions()

  const focusedAccessor = () => (props.focused ? props.focused() : true)

  const [tab, setTab] = createSignal<FileTreeTab>("all")
  const [cursorIndex, setCursorIndex] = createSignal<number>(0)
  const [refreshTick, setRefreshTick] = createSignal<number>(0)

  const [allFiles, setAllFiles] = createSignal<string[] | null>(null, { equals: sameFileList })
  const [changes, setChanges] = createSignal<StatusEntry[] | null>(null, { equals: sameStatusEntries })
  const [error, setError] = createSignal<string | null>(null)
  const [expandedDirs, setExpandedDirs] = createSignal<ReadonlySet<string>>(new Set())
  let fetchSeq = 0

  async function refetch(currentTab: FileTreeTab, path: string | null, signal?: AbortSignal): Promise<void> {
    const seq = ++fetchSeq
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
        if (signal?.aborted || seq !== fetchSeq || props.worktreePath() !== path) return
        setAllFiles(files)
      } else if (currentTab === "changes") {
        const entries = await statusFiles(path, signal)
        if (signal?.aborted || seq !== fetchSeq || props.worktreePath() !== path) return
        setChanges(entries)
      }
    } catch (err) {
      if (signal?.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      if (seq === fetchSeq && props.worktreePath() === path) setError(message)
    }
  }

  createEffect(
    on(props.worktreePath, async (path) => {
      setAllFiles(null)
      setChanges(null)
      setError(null)
      setCursorIndex(0)
      setExpandedDirs(new Set<string>())
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      await refetch(tab(), path, controller.signal)
    }),
  )

  createEffect(
    on(props.worktreePath, (path) => {
      if (path == null) return
      if (process.env.KOBE_FILETREE_WATCH !== "1") return
      onCleanup(watchWorktree(path, () => setRefreshTick((n) => n + 1)))
    }),
  )

  createEffect(
    on(tab, async (currentTab) => {
      const path = props.worktreePath()
      setCursorIndex(0)
      if (path == null) return
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      if (currentTab === "all") {
        if (allFiles() == null) await refetch("all", path, controller.signal)
      } else if (currentTab === "changes") {
        if (changes() == null) await refetch("changes", path, controller.signal)
      }
    }),
  )

  createEffect(
    on(
      refreshTick,
      async () => {
        const currentTab = tab()
        const path = props.worktreePath()
        if (path == null) return
        const controller = new AbortController()
        onCleanup(() => controller.abort())
        await refetch(currentTab, path, controller.signal)
      },
      { defer: true },
    ),
  )

  const tree = createMemo<TreeNode | null>(() => {
    const files = allFiles()
    if (files == null) return null
    return buildTree(files)
  })

  const rows = createMemo<readonly Row[]>((prev) => {
    const next: Row[] = []
    if (tab() === "all") {
      const root = tree()
      if (root != null) flattenTree(root, expandedDirs(), 0, next)
    } else if (tab() === "changes") {
      const list = changes()
      if (list != null) next.push(...statusRows(list))
    }
    return reconcileRows(prev ?? [], next)
  }, [])

  createEffect(
    on(rows, (r) => {
      if (r.length === 0) return
      if (cursorIndex() > r.length - 1) setCursorIndex(r.length - 1)
    }),
  )

  const statWidths = createMemo(() => computeStatWidths(rows()))
  const pathBudget = createMemo(() => computePathBudget(dims().width, statWidths()))

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

  function currentRow(): Row | undefined {
    return rows()[cursorIndex()]
  }

  useFileTreeBindings({
    focused: focusedAccessor,
    moveDown: () => {
      const r = rows()
      if (r.length === 0) return
      setCursorIndex(Math.min(cursorIndex() + 1, r.length - 1))
    },
    moveUp: () => {
      if (rows().length === 0) return
      setCursorIndex(Math.max(cursorIndex() - 1, 0))
    },
    setTab: (t) => setTab(t),
    currentTab: tab,
    openCurrent: () => {
      const row = currentRow()
      if (row) activateRow(row)
    },
    mentionCurrent: () => {
      const row = currentRow()
      if (!row || row.kind === "dir") return
      props.onMention?.(row.path)
    },
    createPR: props.onCreatePR,
    openExternal: () => {
      const row = currentRow()
      if (!row || row.kind === "dir") return
      const wt = props.worktreePath()
      if (!wt) return
      openExternally(`${wt}/${row.path}`)
    },
    refresh: () => {
      setRefreshTick((n) => n + 1)
      props.onRefresh?.()
    },
    expandOrDescend: () => applyNav(expandOrDescendAction(rows(), cursorIndex())),
    collapseOrParent: () => {
      if (tab() !== "all") return
      applyNav(collapseOrParentAction(rows(), cursorIndex()))
    },
  })

  let scrollRef: ScrollBoxRenderable | undefined
  createEffect(
    on([cursorIndex, rows], ([i, r]) => {
      if (!scrollRef) return
      if (r.length === 0) return
      const y = followScrollTop(scrollRef.scrollTop, scrollRef.viewport.height, i)
      if (y != null) scrollRef.scrollTo({ x: 0, y })
    }),
  )

  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingBottom={1} paddingLeft={0} paddingRight={0}>
      {}
      <FileTreeHeaderView
        tab={tab()}
        onSelectTab={setTab}
        cornerBadge={props.cornerBadge?.() ?? null}
        onZenToggle={props.onZenToggle}
        onCreatePR={props.onCreatePR}
      />

      {}
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          scrollRef = r
        }}
        flexGrow={1}
        verticalScrollbarOptions={{
          trackOptions: {
            foregroundColor: "transparent",
          },
        }}
      >
        <Show when={props.worktreePath() == null}>
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>{t("files.empty.noTask")}</text>
          </box>
        </Show>

        <Show when={props.worktreePath() != null && error() != null}>
          <box paddingTop={1} paddingLeft={1} flexDirection="column" gap={0}>
            <text fg={theme.error} wrapMode="word">
              {summarizeGitError(error() ?? "", t)}
            </text>
            <text fg={theme.textMuted} wrapMode="word">
              {t("files.error.retryHint")}
            </text>
          </box>
        </Show>

        <Show
          when={
            props.worktreePath() != null &&
            error() == null &&
            rows().length === 0 &&
            ((tab() === "all" && allFiles() != null) || (tab() === "changes" && changes() != null))
          }
        >
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>{tab() === "all" ? t("files.empty.noFiles") : t("files.empty.noChanges")}</text>
          </box>
        </Show>

        <Show when={props.worktreePath() != null && error() == null && rows().length > 0}>
          <box flexShrink={0} gap={0} paddingRight={1}>
            <For each={rows()}>
              {(row, index) => (
                <FileTreeRowView
                  row={row}
                  cursor={index() === cursorIndex()}
                  statWidths={statWidths()}
                  pathBudget={pathBudget()}
                  onActivate={() => {
                    setCursorIndex(index())
                    activateRow(row)
                  }}
                />
              )}
            </For>
          </box>
        </Show>
      </scrollbox>

      {}
      <Show when={props.worktreePath() != null}>
        <box flexDirection="row" paddingTop={1} flexShrink={0}>
          <text fg={theme.textMuted} wrapMode="none">
            {t("files.footer.openHint")}
          </text>
        </box>
      </Show>
    </box>
  )
}
