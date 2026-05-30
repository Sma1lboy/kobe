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
 * Layout: ~38 cells wide in the old five-pane shell. The width is
 * a layout target, not a hard cap — the parent can adjust by overriding
 * via the surrounding box; we just render as `width={FILETREE_WIDTH}`.
 *
 * Tabs:
 *   - `All`: `git ls-files --cached --others --exclude-standard`
 *     (gitignore respected). Flat list of paths, alphabetically sorted.
 *   - `Changes`: `git status --porcelain`, with a single-char status
 *     prefix coloured per the theme tokens.
 *   - `Checks`: placeholder — CI/test integration not yet implemented.
 *
 * State lives where it lives (DESIGN.md §2.5): files come from disk via
 * git, not from a separate cache. We re-fetch on:
 *   - tab switch
 *   - worktree path change
 *   - explicit `r` keypress
 *   - first mount
 *   - optional filesystem activity inside the worktree when
 *     `KOBE_FILETREE_WATCH=1` is set. Recursive watch is intentionally
 *     opt-in because large monorepos can make the watcher itself more
 *     expensive than a manual refresh.
 *
 * Reactivity: `worktreePath` is an `Accessor` so the pane reacts to
 * task switches without a manual prop-equality check. The internal
 * `entries` signal is recomputed in a `createEffect` that depends on
 * (worktreePath, tab, refreshTick). `refreshTick` is bumped on `r`.
 *
 * Empty / error states:
 *   - `worktreePath() == null` → "No worktree" (we treat this as the
 *     "no task selected" placeholder; matches what the chat pane does
 *     at G3).
 *   - non-null path but listFiles/statusFiles errors → render the
 *     error message in red. Most likely cause: the path isn't a git
 *     worktree yet (orchestrator races during task creation).
 *   - empty results → "No files" (All) or "No changes" (Changes).
 *
 * This file is intentionally cross-stream-import-safe: it imports only
 * from sibling files in the same directory and from `../../context/theme`,
 * `../../lib/keymap`. It never touches the orchestrator (the parent
 * threads `worktreePath` and consumes `onOpenFile`).
 */

import { type FSWatcher, watch } from "node:fs"
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import { type FileStatus, type StatusEntry, type TreeNode, buildTree, listFiles, statusFiles } from "./git"
import { type FileTreeTab, useFileTreeBindings } from "./keys"
import { openExternally } from "./open-external"

/**
 * Default width of the pane in terminal cells from the old centre-column
 * layout. The parent can override via the surrounding box layout if a
 * wider window warrants it; we expose the constant rather than hard-code
 * inside JSX.
 */
export const FILETREE_WIDTH = 38

/**
 * Public props for `FileTree`. Stable contract — `app.tsx` (the
 * orchestrator's integration point) imports this shape from the
 * barrel. Adding fields is fine; renaming or removing is breaking.
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
   * Whether the pane has keyboard focus. Defaults to `() => true` —
   * Wave 3 has no focus manager yet, the integration agent will
   * thread real signals when the 5-pane layout lands.
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

/**
 * Internal row shape. The All tab renders a tree (files + collapsible
 * directories with `depth` for indentation). The Changes tab renders a
 * flat list of status rows carrying +/- diff stats.
 */
type Row =
  | { kind: "file"; path: string; name: string; depth: number }
  | { kind: "dir"; path: string; name: string; depth: number; expanded: boolean; hasChildren: boolean }
  | {
      kind: "status"
      path: string
      status: FileStatus
      added: number | null | undefined
      deleted: number | null | undefined
    }

/**
 * Map a status code to its theme token. Resolved at render time so a
 * theme switch reactively recolours pre-existing rows.
 */
function statusToken(s: FileStatus): "warning" | "success" | "error" | "textMuted" | "info" {
  switch (s) {
    case "M":
      return "warning"
    case "A":
      return "success"
    case "D":
      return "error"
    case "?":
      return "textMuted"
    case "R":
    case "C":
    case "U":
      // Renames/copies/conflicts are uncommon in the loop; render
      // them in info-blue to distinguish from the M/A/D/? majority.
      return "info"
  }
}

/**
 * The tabs in render order. `as const` so TypeScript keeps the
 * literal-tuple narrowing for downstream `.map()` callers.
 */
const TABS = ["all", "changes"] as const satisfies readonly FileTreeTab[]

/**
 * Boil a raw `git ls-files` / `git status` error down to a single
 * human-friendly sentence. The thrown messages from `git.ts` look
 * like `git ls-files ... (cwd=/foo) exited with code 128: fatal: not
 * a git repository`. Most users don't need the full args / exit
 * code; we surface the common cases and keep the rest generic.
 */
export function summarizeGitError(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes("not a git repository")) return "not a git repository"
  if (m.includes("does not exist") || m.includes("enoent")) return "worktree path is missing"
  if (m.includes("permission denied") || m.includes("eacces")) return "permission denied"
  if (m.includes("git: not found") || m.includes("command not found")) return "git is not installed"
  // Fallback: strip the leading `git <args> (cwd=...)` boilerplate.
  const colon = raw.indexOf(": ")
  if (colon >= 0 && raw.startsWith("git ")) return raw.slice(colon + 2).trim() || "git command failed"
  return raw.trim() || "git command failed"
}

/** Display label for each tab. */
const TAB_LABEL: Record<FileTreeTab, string> = {
  all: "All",
  changes: "Changes",
}

export function FileTree(props: FileTreeProps) {
  const { theme } = useTheme()

  // Default `focused` accessor — see file header.
  const focusedAccessor = () => (props.focused ? props.focused() : true)

  // ---------- pane state ----------
  const [tab, setTab] = createSignal<FileTreeTab>("all")
  const [cursorIndex, setCursorIndex] = createSignal<number>(0)
  // Bumped by `r` to force a re-fetch.
  const [refreshTick, setRefreshTick] = createSignal<number>(0)

  // Loaded data + last error per fetch. We keep both `allFiles` and
  // `changes` so a tab switch is instant if both have been loaded
  // already (and refreshes when the user explicitly asks).
  const [allFiles, setAllFiles] = createSignal<string[] | null>(null)
  const [changes, setChanges] = createSignal<StatusEntry[] | null>(null)
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
  async function refetch(currentTab: FileTreeTab, path: string | null): Promise<void> {
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
        const files = await listFiles(path)
        if (seq !== fetchSeq || props.worktreePath() !== path) return
        setAllFiles(files)
      } else if (currentTab === "changes") {
        const entries = await statusFiles(path)
        if (seq !== fetchSeq || props.worktreePath() !== path) return
        setChanges(entries)
      }
    } catch (err) {
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
      await refetch(tab(), path)
    }),
  )

  // Realtime watch is opt-in. On large repos a recursive watcher can
  // overwhelm the TUI process before the user does anything, so the
  // default path is explicit refresh (`r`) plus tab/worktree changes.
  createEffect(
    on(props.worktreePath, (path) => {
      if (path == null) return
      if (process.env.KOBE_FILETREE_WATCH !== "1") return
      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      let watcher: FSWatcher | null = null
      try {
        watcher = watch(path, { recursive: true }, (_event, filename) => {
          if (filename == null) return
          const f = filename.toString()
          if (f === ".git" || f.startsWith(".git/") || f.startsWith(".git\\")) return
          if (f.startsWith("node_modules/") || f.startsWith("node_modules\\")) return
          if (debounceTimer != null) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            debounceTimer = null
            setRefreshTick((n) => n + 1)
          }, 500)
        })
        watcher.on("error", () => {
          // Swallow — the `r` keystroke remains as the escape hatch.
        })
      } catch {
        // Path missing or not watchable — fall back to manual refresh.
      }
      onCleanup(() => {
        if (debounceTimer != null) clearTimeout(debounceTimer)
        if (watcher != null) watcher.close()
      })
    }),
  )

  // Re-fetch when the active tab changes (only if data isn't loaded
  // yet) and on every refresh tick.
  createEffect(
    on([tab, refreshTick], async ([currentTab, _tick]) => {
      const path = props.worktreePath()
      if (path == null) return
      // Reset cursor on tab switch — different row count, different list.
      setCursorIndex(0)
      // For an explicit refresh tick > 0 we always re-fetch even if
      // data is loaded.
      const tickVal = refreshTick()
      const isExplicitRefresh = tickVal > 0
      if (currentTab === "all") {
        if (allFiles() == null || isExplicitRefresh) {
          await refetch("all", path)
        }
      } else if (currentTab === "changes") {
        if (changes() == null || isExplicitRefresh) {
          await refetch("changes", path)
        }
      }
    }),
  )

  // Tree built once per `allFiles` change and reused while expansion
  // state mutates — flattening below is O(visible-rows), which is
  // ~hundreds in practice and runs only when `expandedDirs` changes.
  const tree = createMemo<TreeNode | null>(() => {
    const files = allFiles()
    if (files == null) return null
    return buildTree(files)
  })

  function flattenTree(node: TreeNode, expanded: ReadonlySet<string>, depth: number, out: Row[]): void {
    for (const child of node.children) {
      if (child.isDir) {
        const isOpen = expanded.has(child.path)
        out.push({
          kind: "dir",
          path: child.path,
          name: child.name,
          depth,
          expanded: isOpen,
          hasChildren: child.children.length > 0,
        })
        if (isOpen) flattenTree(child, expanded, depth + 1, out)
      } else {
        out.push({ kind: "file", path: child.path, name: child.name, depth })
      }
    }
  }

  // ---------- derived rows ----------
  const rows = createMemo<Row[]>(() => {
    if (tab() === "all") {
      const root = tree()
      if (root == null) return []
      const out: Row[] = []
      flattenTree(root, expandedDirs(), 0, out)
      return out
    }
    if (tab() === "changes") {
      const list = changes()
      if (list == null) return []
      return list.map((e) => ({
        kind: "status" as const,
        path: e.path,
        status: e.status,
        added: e.added,
        deleted: e.deleted,
      }))
    }
    return []
  })

  /**
   * Column widths for the `+N` / `-N` stats on the Changes tab. Computed
   * across the visible rows so every cell pads to the widest sibling —
   * without this, `+0 -202` and `+1 -1` end at the same right edge but
   * the `-` columns drift, which reads as misaligned. Width includes
   * the leading sign (`+`/`-`).
   */
  const statWidths = createMemo<{ added: number; deleted: number }>(() => {
    let added = 0
    let deleted = 0
    for (const row of rows()) {
      if (row.kind !== "status") continue
      if (row.added != null) added = Math.max(added, String(row.added).length + 1)
      if (row.deleted != null) deleted = Math.max(deleted, String(row.deleted).length + 1)
    }
    return { added, deleted }
  })

  // ---------- key bindings ----------
  function moveDown(): void {
    const r = rows()
    if (r.length === 0) return
    setCursorIndex(Math.min(cursorIndex() + 1, r.length - 1))
  }
  function moveUp(): void {
    if (rows().length === 0) return
    setCursorIndex(Math.max(cursorIndex() - 1, 0))
  }

  /** `l` — hierarchy navigation only. On a closed dir, expand it; on
   * an open dir, step into its first child; on a file, no-op (use
   * `enter` to open). Keeping `l` purely structural lets the user roam
   * through the tree without accidentally pulling the file into the
   * preview pane. */
  function expandOrDescend(): void {
    const r = rows()
    const i = cursorIndex()
    const row = r[i]
    if (!row) return
    if (row.kind !== "dir") return
    if (!row.expanded && row.hasChildren) {
      setExpandedDirs((prev) => {
        const next = new Set(prev)
        next.add(row.path)
        return next
      })
    } else if (row.expanded) {
      if (i + 1 < r.length) setCursorIndex(i + 1)
    }
  }

  /** `h` — collapse current directory, or jump to parent. Behavior on
   * the All tab; no-op elsewhere. */
  function collapseOrParent(): void {
    if (tab() !== "all") return
    const r = rows()
    const i = cursorIndex()
    const row = r[i]
    if (!row) return
    // Open dir → collapse.
    if (row.kind === "dir" && row.expanded) {
      setExpandedDirs((prev) => {
        const next = new Set(prev)
        next.delete(row.path)
        return next
      })
      return
    }
    // Otherwise jump to parent dir (depth - 1) walking upward in rows.
    if (row.kind !== "dir" && row.kind !== "file") return
    const targetDepth = row.depth - 1
    if (targetDepth < 0) return
    for (let j = i - 1; j >= 0; j--) {
      const candidate = r[j]
      if (!candidate) continue
      if (candidate.kind === "dir" && candidate.depth === targetDepth) {
        setCursorIndex(j)
        return
      }
    }
  }

  function openCurrent(): void {
    const r = rows()
    const i = cursorIndex()
    if (i < 0 || i >= r.length) return
    const row = r[i]
    if (!row) return
    if (row.kind === "dir") {
      // Toggle expansion on enter for directory rows.
      setExpandedDirs((prev) => {
        const next = new Set(prev)
        if (next.has(row.path)) next.delete(row.path)
        else next.add(row.path)
        return next
      })
      return
    }
    props.onOpenFile(row.path)
  }
  function mentionCurrent(): void {
    const r = rows()
    const i = cursorIndex()
    if (i < 0 || i >= r.length) return
    const row = r[i]
    // Only files make sense as an @mention; dirs are ignored.
    if (!row || row.kind === "dir") return
    props.onMention?.(row.path)
  }
  function refresh(): void {
    setRefreshTick((n) => n + 1)
    props.onRefresh?.()
  }
  function openExternal(): void {
    const r = rows()
    const i = cursorIndex()
    if (i < 0 || i >= r.length) return
    const row = r[i]
    if (!row || row.kind === "dir") return
    const wt = props.worktreePath()
    if (!wt) return
    const absPath = `${wt}/${row.path}`
    openExternally(absPath)
  }

  useFileTreeBindings({
    focused: focusedAccessor,
    moveDown,
    moveUp,
    setTab: (t) => setTab(t),
    currentTab: tab,
    openCurrent,
    mentionCurrent,
    openExternal,
    refresh,
    expandOrDescend,
    collapseOrParent,
  })

  // ---------- viewport follow ----------
  // Each row renders as a height-1 box, so its y-offset inside the
  // scrollbox content equals its index in `rows()`. When the cursor
  // moves past the visible window (either edge), nudge the scrollbox
  // so the cursor row is just inside the viewport.
  let scrollRef: ScrollBoxRenderable | undefined
  createEffect(
    on([cursorIndex, rows], ([i, r]) => {
      if (!scrollRef) return
      if (r.length === 0) return
      const top = scrollRef.scrollTop
      const height = scrollRef.viewport.height
      if (height <= 0) return
      if (i < top) {
        scrollRef.scrollTo({ x: 0, y: i })
      } else if (i >= top + height) {
        scrollRef.scrollTo({ x: 0, y: i - height + 1 })
      }
    }),
  )

  // ---------- render ----------
  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      {/* Header: tabs row. Each tab is clickable (sets active), and
         `1` / `2` / `3` switch from the keyboard. */}
      <box flexDirection="row" justifyContent="space-between" paddingBottom={0} flexShrink={0}>
        <box flexDirection="row" gap={2}>
          <For each={TABS}>
            {(t) => {
              const isActive = () => tab() === t
              return (
                <text
                  fg={isActive() ? theme.primary : theme.textMuted}
                  attributes={isActive() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  onMouseUp={() => setTab(t)}
                >
                  {TAB_LABEL[t]}
                </text>
              )
            }}
          </For>
        </box>
        {/* Right-aligned activity badge (KOB-254). No background fill so
           it stays clean in transparent mode. */}
        <Show when={props.cornerBadge?.()}>
          {(badge) => (
            <text
              fg={badge().active ? theme.accent : theme.textMuted}
              attributes={badge().active ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              {badge().text}
            </text>
          )}
        </Show>
      </box>
      {/* Status legend — only shown on the Changes tab so users can
         decode single-char git status codes without leaving the TUI. */}
      <Show when={tab() === "changes"}>
        <box flexDirection="row" paddingBottom={1} flexShrink={0}>
          <text fg={theme.textMuted} wrapMode="none">
            M modified · A added · D deleted · ? untracked
          </text>
        </box>
      </Show>
      <Show when={tab() !== "changes"}>
        <box flexDirection="row" paddingBottom={1} flexShrink={0} />
      </Show>

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
            <text fg={theme.textMuted}>(no task — press n to create)</text>
          </box>
        </Show>

        <Show when={props.worktreePath() != null && error() != null}>
          <box paddingTop={1} paddingLeft={1} flexDirection="column" gap={0}>
            <text fg={theme.error} wrapMode="word">
              {summarizeGitError(error() ?? "")}
            </text>
            <text fg={theme.textMuted} wrapMode="word">
              press r to retry
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
            <text fg={theme.textMuted}>{tab() === "all" ? "(empty worktree)" : "(no changes — clean worktree)"}</text>
          </box>
        </Show>

        <Show when={props.worktreePath() != null && error() == null && rows().length > 0}>
          <box flexShrink={0} gap={0} paddingRight={1}>
            <For each={rows()}>
              {(row, index) => {
                const isCursor = () => index() === cursorIndex()
                if (row.kind === "dir") {
                  // Indent: 2 cells per depth level. Marker: ▾ open, ▸ closed.
                  const indent = "  ".repeat(row.depth)
                  const marker = row.expanded ? "▾" : "▸"
                  return (
                    <box
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={isCursor() ? theme.primary : undefined}
                      onMouseUp={() => {
                        setCursorIndex(index())
                        setExpandedDirs((prev) => {
                          const next = new Set(prev)
                          if (next.has(row.path)) next.delete(row.path)
                          else next.add(row.path)
                          return next
                        })
                      }}
                    >
                      <text
                        fg={isCursor() ? theme.selectedListItemText : theme.textMuted}
                        attributes={TextAttributes.BOLD}
                        wrapMode="none"
                      >
                        {`${indent}${marker} ${row.name}/`}
                      </text>
                    </box>
                  )
                }
                if (row.kind === "file") {
                  const indent = "  ".repeat(row.depth)
                  // Two-cell gutter where the dir marker would sit.
                  return (
                    <box
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={isCursor() ? theme.primary : undefined}
                      onMouseUp={() => {
                        setCursorIndex(index())
                        props.onOpenFile(row.path)
                      }}
                    >
                      <text fg={isCursor() ? theme.selectedListItemText : theme.text} wrapMode="none">
                        {`${indent}  ${row.name}`}
                      </text>
                    </box>
                  )
                }
                // Changes row: status char + path + +N -N stats.
                const tone = statusToken(row.status)
                const statusColor = () => {
                  switch (tone) {
                    case "success":
                      return theme.success
                    case "warning":
                      return theme.warning
                    case "error":
                      return theme.error
                    case "info":
                      return theme.info
                    default:
                      return theme.textMuted
                  }
                }
                const w = statWidths()
                const addedText = row.added == null ? " ".repeat(w.added) : `+${row.added}`.padStart(w.added)
                const deletedText = row.deleted == null ? " ".repeat(w.deleted) : `-${row.deleted}`.padStart(w.deleted)
                return (
                  <box
                    flexDirection="row"
                    gap={1}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={isCursor() ? theme.primary : undefined}
                    onMouseUp={() => {
                      setCursorIndex(index())
                      props.onOpenFile(row.path)
                    }}
                  >
                    <text fg={isCursor() ? theme.selectedListItemText : statusColor()} wrapMode="none">
                      {row.status}
                    </text>
                    <text fg={isCursor() ? theme.selectedListItemText : theme.text} wrapMode="none" flexGrow={1}>
                      {row.path}
                    </text>
                    <Show when={w.added > 0}>
                      <text fg={isCursor() ? theme.selectedListItemText : theme.success} wrapMode="none">
                        {addedText}
                      </text>
                    </Show>
                    <Show when={w.deleted > 0}>
                      <text fg={isCursor() ? theme.selectedListItemText : theme.error} wrapMode="none">
                        {deletedText}
                      </text>
                    </Show>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </scrollbox>
    </box>
  )
}
