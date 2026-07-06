/**
 * Wave 3 Stream H — file tree pane.
 *
 * Top-right pane in the Conductor screenshot grammar (DESIGN.md §1).
 * Lists the active task's worktree files, with a tabbed header for
 * filtering/scoping:
 *
 *   ┌────────────────────────────────────────┐
 *   │  All   Changes                         │  ← tabs ([/])
 *   ├────────────────────────────────────────┤
 *   │  .prettierrc                            │
 *   │  bun.lock                               │
 *   │  M src/index.ts                         │  (Changes tab only)
 *   │  ? new-file.txt                         │  (Changes tab only)
 *   │  ...                                    │
 *   └────────────────────────────────────────┘
 *
 * Tabs:
 *   - `All`: `git ls-files --cached --others --exclude-standard`
 *     (gitignore respected). Collapsible directory tree.
 *   - `Changes`: `git status --porcelain`, with a single-char status
 *     prefix coloured per the theme tokens.
 *
 * State lives where it lives (DESIGN.md §2.5): files come from disk via
 * git, not from a separate cache. We re-fetch on tab switch, worktree
 * path change, explicit `r`, first mount, and (opt-in via
 * `KOBE_FILETREE_WATCH=1`) filesystem activity inside the worktree.
 *
 * Reactivity: `worktreePath` is an `Accessor` so the pane reacts to
 * task switches without a manual prop-equality check. Data is refetched
 * by three separate effects — on `worktreePath` (wipe + reload), on `tab`
 * (cache-first tab switch + cursor reset), and on `refreshTick` (deferred;
 * always reloads the active tab, PRESERVING the cursor). `refreshTick` is
 * bumped by `r` and by the debounced fs-watch handler.
 *
 * Empty / error states:
 *   - `worktreePath() == null` → "No worktree" placeholder.
 *   - non-null path but listFiles/statusFiles errors → the error message
 *     in red (most likely: the path isn't a git worktree yet).
 *   - empty results → "No files" (All) or "No changes" (Changes).
 *
 * Split for the 500-line cap (issue #15, G3): pure pane logic lives in
 * `pane-core.ts`, the bindings map in `keys-core.ts`, the per-row view in
 * `row-view.tsx` — all shared with the React port. This file owns only
 * the Solid reactivity + pane chrome.
 */

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

/**
 * Default width of the pane in terminal cells from the old centre-column
 * layout. The parent can override via the surrounding box layout if a
 * wider window warrants it; we expose the constant rather than hard-code
 * inside JSX.
 */
export const FILETREE_WIDTH = 38

/**
 * Public props for `FileTree`. Stable contract — adding fields is fine;
 * renaming or removing is breaking.
 */
export type FileTreeProps = {
  /**
   * Active task's worktree path. `null` when no task is selected (we
   * render the "No worktree" placeholder). `Accessor` shape so task
   * switches reactively re-fetch.
   */
  worktreePath: Accessor<string | null>
  /**
   * Fires when the user activates a row (enter / click). The `relPath`
   * is relative to the worktree root, suitable for `git diff` etc.
   */
  onOpenFile: (relPath: string) => void
  /**
   * Fires when the user requests an `@<path>` mention of the current
   * file (the `a` key). The Ops host wires this to a tmux send-keys
   * injection into the engine pane; omit it elsewhere (the key no-ops).
   */
  onMention?: (relPath: string) => void
  /**
   * Optional Ops-pane action: request PR creation for this worktree.
   * Rendered as a slim action row above the All / Changes tabs and bound
   * to `p`, so Create PR is reachable from both tabs.
   */
  onCreatePR?: () => void
  /**
   * Optional Ops-pane action: toggle zen mode (collapse the ChatTab to the
   * engine pane). Rendered as a clickable chip left of Create PR in the same
   * action row. Entering zen hides this very pane, so the way back out is the
   * `prefix`-space chord (or the kept Tasks rail) — this chip is enter-only.
   */
  onZenToggle?: () => void
  /**
   * Whether the pane has keyboard focus. Defaults to `() => true`.
   */
  focused?: Accessor<boolean>
  /**
   * Optional right-aligned badge in the header (KOB-254). The Ops host
   * uses it to surface "new engine activity since you last looked" —
   * `active: true` paints it in the accent colour. Omit (or return
   * `null`) to hide it.
   */
  cornerBadge?: Accessor<{ text: string; active: boolean } | null>
  /**
   * Fires when the user explicitly refreshes the pane (`r`). The Ops
   * host treats a refresh as "I've looked" and clears the activity
   * badge (KOB-254).
   */
  onRefresh?: () => void
}

export function FileTree(props: FileTreeProps) {
  const { theme } = useTheme()

  // Pane width — in the Ops pane each FileTree runs in its own tmux pane
  // process, so `useTerminalDimensions` tracks THIS pane's size and reflows
  // the Changes-tab path truncation on resize.
  const dims = useTerminalDimensions()

  // Default `focused` accessor — see props doc.
  const focusedAccessor = () => (props.focused ? props.focused() : true)

  // ---------- pane state ----------
  const [tab, setTab] = createSignal<FileTreeTab>("all")
  const [cursorIndex, setCursorIndex] = createSignal<number>(0)
  // Bumped by `r` to force a re-fetch.
  const [refreshTick, setRefreshTick] = createSignal<number>(0)

  // Loaded data + last error per fetch. We keep both `allFiles` and
  // `changes` so a tab switch is instant if both have been loaded
  // already (and refreshes when the user explicitly asks).
  //
  // Content-equality on both signals is load-bearing for memory, not a
  // perf nicety: the Ops pane refreshes on fs-watch events, and most
  // events don't change the `git ls-files` / `git status` output at all
  // (an engine re-writing a tracked file leaves the All list identical).
  // Without `equals`, every refresh notified downstream, rebuilt every
  // row, and forced `<For>` to recreate every opentui renderable —
  // which leaks natively in @opentui/core 0.2.4 (see rows.ts).
  const [allFiles, setAllFiles] = createSignal<string[] | null>(null, { equals: sameFileList })
  const [changes, setChanges] = createSignal<StatusEntry[] | null>(null, { equals: sameStatusEntries })
  const [error, setError] = createSignal<string | null>(null)
  // Set of expanded directory paths (relative to worktree root). The
  // tree renders top-level entries always; deeper levels show only
  // when their parent is in the set. Reset on worktree change.
  const [expandedDirs, setExpandedDirs] = createSignal<ReadonlySet<string>>(new Set())
  let fetchSeq = 0

  /**
   * Fetch the data for the current tab. Errors land in `error()` and
   * the row list goes empty. We deliberately set the *non-active*
   * tab's data to `null` only when the worktree changes, not on tab
   * switch — re-fetching every time the user pings 1/2/1/2 would be
   * wasteful and disorienting.
   */
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
      // An aborted fetch (tab/worktree changed out from under us) throws
      // via the killed subprocess — swallow it, the next run owns state.
      if (signal?.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      if (seq === fetchSeq && props.worktreePath() === path) setError(message)
    }
  }

  // Re-fetch when worktree changes — wipe all caches first because the
  // old cache no longer applies.
  createEffect(
    on(props.worktreePath, async (path) => {
      setAllFiles(null)
      setChanges(null)
      setError(null)
      setCursorIndex(0)
      setExpandedDirs(new Set<string>())
      // Abort the in-flight git read if the worktree changes again before
      // it resolves, so rapid task-switches don't stack subprocesses.
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      await refetch(tab(), path, controller.signal)
    }),
  )

  // Realtime watch is opt-in (see watchWorktree) — the default path is
  // explicit refresh (`r`) plus tab/worktree changes.
  createEffect(
    on(props.worktreePath, (path) => {
      if (path == null) return
      if (process.env.KOBE_FILETREE_WATCH !== "1") return
      onCleanup(watchWorktree(path, () => setRefreshTick((n) => n + 1)))
    }),
  )

  // Re-fetch when the active TAB changes — cache-first, so pinging
  // 1/2/1/2 between already-loaded tabs never respawns git. Resetting the
  // cursor belongs here (a different tab is a different list); a refresh of
  // the SAME tab must NOT yank the cursor to the top (that effect is below).
  createEffect(
    on(tab, async (currentTab) => {
      const path = props.worktreePath()
      // Reset cursor on tab switch — different row count, different list.
      setCursorIndex(0)
      if (path == null) return
      // Abort an overlapping git read if the tab switches again before this
      // one resolves — without this, a rapid 1/2/1/2 stacks live subprocesses
      // even though `fetchSeq` already drops their stale writes.
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      if (currentTab === "all") {
        if (allFiles() == null) await refetch("all", path, controller.signal)
      } else if (currentTab === "changes") {
        if (changes() == null) await refetch("changes", path, controller.signal)
      }
    }),
  )

  // Re-fetch on a real refresh tick (`r` or a debounced fs-watch event).
  // `defer: true` skips the tick=0 mount run — the worktree effect already
  // does the first fetch — so this fires only when the tick actually changes.
  // Unlike a tab switch, a refresh PRESERVES the cursor (the clamp effect
  // below pulls it back only if the row count shrank past it), so an engine
  // writing files under the Ops pane no longer snaps the view to the top.
  createEffect(
    on(
      refreshTick,
      async () => {
        const currentTab = tab()
        const path = props.worktreePath()
        if (path == null) return
        // Abort an overlapping read if another tick lands before this resolves.
        const controller = new AbortController()
        onCleanup(() => controller.abort())
        await refetch(currentTab, path, controller.signal)
      },
      { defer: true },
    ),
  )

  // Tree built once per `allFiles` change and reused while expansion
  // state mutates — flattening below is O(visible-rows), which is
  // ~hundreds in practice and runs only when `expandedDirs` changes.
  const tree = createMemo<TreeNode | null>(() => {
    const files = allFiles()
    if (files == null) return null
    return buildTree(files)
  })

  // ---------- derived rows ----------
  // Rebuilds produce fresh row objects, but `<For>` keys by identity —
  // so the memo reconciles against its previous value and keeps the old
  // object for every row whose fields are unchanged. Renderables are
  // then reused instead of destroyed+recreated (rows.ts has the full
  // memory-leak story). Returning `prev` itself when nothing changed
  // also suppresses downstream notification entirely.
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

  // Keep the cursor in range when a refresh shrinks the list (e.g. an engine
  // deletes files). Tab switches already reset the cursor to 0, so this is a
  // no-op there; it only clamps a preserved cursor that now points past the end.
  createEffect(
    on(rows, (r) => {
      if (r.length === 0) return
      if (cursorIndex() > r.length - 1) setCursorIndex(r.length - 1)
    }),
  )

  const statWidths = createMemo(() => computeStatWidths(rows()))
  const pathBudget = createMemo(() => computePathBudget(dims().width, statWidths()))

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
      // Only files make sense as an @mention; dirs are ignored.
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

  // ---------- viewport follow ----------
  let scrollRef: ScrollBoxRenderable | undefined
  createEffect(
    on([cursorIndex, rows], ([i, r]) => {
      if (!scrollRef) return
      if (r.length === 0) return
      const y = followScrollTop(scrollRef.scrollTop, scrollRef.viewport.height, i)
      if (y != null) scrollRef.scrollTo({ x: 0, y })
    }),
  )

  // ---------- render ----------
  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingBottom={1} paddingLeft={0} paddingRight={0}>
      {/* Header chrome — action chips, tab row, badge, legend. */}
      <FileTreeHeaderView
        tab={tab()}
        onSelectTab={setTab}
        cornerBadge={props.cornerBadge?.() ?? null}
        onZenToggle={props.onZenToggle}
        onCreatePR={props.onCreatePR}
      />

      {/* Body: scrollable list. Scrollbar styled subtle — track blends
         into the panel bg, thumb is muted text color. */}
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          scrollRef = r
        }}
        flexGrow={1}
        verticalScrollbarOptions={{
          trackOptions: {
            // Track + thumb both transparent → invisible by default but
            // still scrollable. Drag/keyboard scrolling works regardless.
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

      {/* Footer hint — `enter` opens the file (nvim diff vs HEAD when
         changed, plain edit otherwise; opentui preview if no nvim/vim).
         Shown only when a worktree is loaded so the "no task" placeholder
         stays clean. */}
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
