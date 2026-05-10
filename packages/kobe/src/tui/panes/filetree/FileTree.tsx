/**
 * Wave 3 Stream H — file tree pane.
 *
 * Top-right pane in the Conductor screenshot grammar (DESIGN.md §1).
 * Lists the active task's worktree files, with a tabbed header for
 * filtering/scoping:
 *
 *   ┌────────────────────────────────────────┐
 *   │  All   Changes   Checks                │  ← tabs (1/2/3)
 *   ├────────────────────────────────────────┤
 *   │  .prettierrc                            │
 *   │  bun.lock                               │
 *   │  M src/index.ts                         │  (Changes tab only)
 *   │  ? new-file.txt                         │  (Changes tab only)
 *   │  ...                                    │
 *   └────────────────────────────────────────┘
 *
 * Layout: ~38 cells wide (paired with the sidebar's 42). The width is
 * a layout target, not a hard cap — the parent can adjust by overriding
 * via the surrounding box; we just render as `width={FILETREE_WIDTH}`.
 *
 * Tabs:
 *   - `All`: `git ls-files --cached --others --exclude-standard`
 *     (gitignore respected). Flat list of paths, alphabetically sorted.
 *   - `Changes`: `git status --porcelain`, with a single-char status
 *     prefix coloured per the theme tokens.
 *   - `Checks`: placeholder ("No checks yet (Wave 4)") — Stream K owns
 *     the real implementation.
 *
 * State lives where it lives (DESIGN.md §2.5): files come from disk via
 * git, not from a separate cache. We re-fetch on:
 *   - tab switch
 *   - worktree path change
 *   - explicit `r` keypress
 *   - first mount
 *
 * No filesystem watcher in v1 — the brief explicitly defers it to Wave
 * 4 polish. The `r` refresh keystroke is the user's escape hatch.
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

import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { useTheme } from "../../context/theme"
import { type FileStatus, type StatusEntry, listFiles, statusFiles } from "./git"
import { type FileTreeTab, useFileTreeBindings } from "./keys"

/**
 * Default width of the pane in terminal cells. Paired with the
 * sidebar's 42 to leave the centre column ~roomy on an 80x24 terminal.
 * The parent can override via the surrounding box layout if a wider
 * window warrants it; we expose the constant rather than hard-code
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
   * Whether the pane has keyboard focus. Defaults to `() => true` —
   * Wave 3 has no focus manager yet, the integration agent will
   * thread real signals when the 5-pane layout lands.
   */
  focused?: Accessor<boolean>
}

/**
 * Internal row shape. `All` rows carry just a path; `Changes` rows
 * carry a status code too. Tabs render their own row variant; we use
 * a discriminated union to keep the cursor logic uniform.
 */
type Row = { kind: "file"; path: string } | { kind: "status"; path: string; status: FileStatus }

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
const TABS = ["all", "changes", "checks"] as const satisfies readonly FileTreeTab[]

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
  checks: "Checks",
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

  /**
   * Fetch the data for the current tab. Errors land in `error()` and
   * the row list goes empty. We deliberately set the *non-active*
   * tab's data to `null` only when the worktree changes, not on tab
   * switch — re-fetching every time the user pings 1/2/1/2 would be
   * wasteful and disorienting.
   */
  async function refetch(currentTab: FileTreeTab, path: string | null): Promise<void> {
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
        setAllFiles(files)
      } else if (currentTab === "changes") {
        const entries = await statusFiles(path)
        setChanges(entries)
      }
      // `checks` has no data to fetch in v1.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
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
      await refetch(tab(), path)
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

  // ---------- derived rows ----------
  const rows = createMemo<Row[]>(() => {
    if (tab() === "all") {
      const files = allFiles()
      if (files == null) return []
      return files.map((p) => ({ kind: "file" as const, path: p }))
    }
    if (tab() === "changes") {
      const list = changes()
      if (list == null) return []
      return list.map((e) => ({ kind: "status" as const, path: e.path, status: e.status }))
    }
    // checks tab — no rows in v1
    return []
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
  function openCurrent(): void {
    const r = rows()
    const i = cursorIndex()
    if (i < 0 || i >= r.length) return
    const row = r[i]
    if (!row) return
    props.onOpenFile(row.path)
  }
  function refresh(): void {
    setRefreshTick((n) => n + 1)
  }

  useFileTreeBindings({
    focused: focusedAccessor,
    moveDown,
    moveUp,
    setTab: (t) => setTab(t),
    openCurrent,
    refresh,
  })

  // ---------- render ----------
  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      {/* Header: tabs row. Each tab is clickable (sets active), and
         `1` / `2` / `3` switch from the keyboard. */}
      <box flexDirection="row" gap={2} paddingBottom={1} flexShrink={0}>
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

      {/* Body: scrollable list. Scrollbar styled subtle — track blends
         into the panel bg, thumb is muted text color. */}
      <scrollbox
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

        <Show when={props.worktreePath() != null && error() == null && tab() === "checks"}>
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>(no checks yet — wave 4)</text>
          </box>
        </Show>

        <Show
          when={
            props.worktreePath() != null &&
            error() == null &&
            tab() !== "checks" &&
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
                if (row.kind === "file") {
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
                        {row.path}
                      </text>
                    </box>
                  )
                }
                // Changes row: status char + path.
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
                    <text fg={isCursor() ? theme.selectedListItemText : theme.text} wrapMode="none">
                      {row.path}
                    </text>
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
