/**
 * kobe sidebar pane (Stream F → Wave 4.A → Wave 4.5).
 *
 * Wave 4.5 reverses Wave 4.A's repo grouping. Jackson's call: a flat
 * task list is fine, and selected-task metadata (repo / branch /
 * worktree path) is surfaced in the topbar instead. The sidebar now
 * splits tasks into two views, switchable with `[` and `]`:
 *
 *   ┌───────────────────────────────────────┐
 *   │ kobe                                   │
 *   │                                        │
 *   │ [ Working session ]   Archives         │
 *   │                                        │
 *   │   ● fix login redirect bug             │
 *   │   ○ refactor auth service              │
 *   │   ○ add password reset                 │
 *   │                                        │
 *   │ + New task                              │
 *   └───────────────────────────────────────┘
 *
 * The active view shows tasks where `task.archived === false`; the
 * archived view shows the rest. `a` on a row toggles its archived flag
 * (non-destructive; the worktree, the branch, and the chat history all
 * stay).
 *
 * The 42-cell sidebar width is a documented hardcode (CLAUDE.md
 * "flex-first, hardcode last"): convention rationale — matches
 * opencode/agent-deck precedent for "history rail" panes.
 *
 * Status badges (●○) still render on per-task rows as a visual hint of
 * the underlying `task.status` (the orchestrator's concurrency cap and
 * lifecycle still depend on it), but the sidebar no longer groups
 * by status, by repo, or by anything else — only the active-view
 * filter applies.
 *
 * Cursor / nav: a Solid signal `cursorIndex` indexes the *flat*
 * navigable task list within the active view. View switches reset the
 * cursor to 0. `enter` selects, `d` deletes, `a` toggles archive,
 * `[`/`]` switches view, `g g` jumps to top, `G` jumps to bottom.
 *
 * Reactivity: every prop is an `Accessor`. We never `.map()` arrays in
 * JSX — `For` is used so Solid keeps the row list reactive. The view
 * filter and row build recompute via `createMemo` only when their
 * inputs change.
 *
 * Focus: `props.focused` defaults to `() => true` so embedders that
 * don't yet thread the focus signal still get a working sidebar.
 */

import type { Task, TaskStatus } from "@/types"
import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, untrack } from "solid-js"
import { SIDEBAR_WIDTH } from "../../component/sidebar"
import { useTheme } from "../../context/theme"
import { type SidebarView, buildRows, flattenIds } from "./groups"
import { useSidebarBindings } from "./keys"

export type SidebarProps = {
  tasks: Accessor<readonly Task[]>
  selectedId: Accessor<string | null>
  onSelect: (id: string) => void
  focused?: Accessor<boolean>
  onDeleteRequest?: (taskId: string) => void
  /**
   * Archive-toggle callback. Wave 4.5: pressing `a` flips the cursor
   * task's `archived` flag, which moves it between the Working session
   * and Archives views.
   */
  onArchiveRequest?: (taskId: string) => void
  /**
   * Rename callback. Pressing `r` on the cursor task emits this with
   * the task id; the parent (app.tsx) opens an input dialog defaulted
   * to the current title and on submit calls `orchestrator.setTitle`.
   */
  onRenameRequest?: (taskId: string) => void
  /**
   * Optional callback for the `+ New task` footer affordance. Left
   * undefined this stream; the global `n`/`ctrl+n` bindings remain the
   * canonical entry point.
   */
  onAddTask?: () => void
  /**
   * Optional width override. When omitted, falls back to {@link SIDEBAR_WIDTH}.
   * Wired by the Shell so the sidebar↔workspace splitter can resize the pane
   * at runtime. Reactive — changing the accessor's value reflows immediately.
   */
  width?: Accessor<number>
}

/**
 * Glyph + theme-token name for each status's badge. We render the glyph
 * with the theme colour resolved at render time; storing the *tone* (not
 * the resolved RGBA) keeps badges reactive to theme switches.
 *
 * Per-task hint only — no grouping reads from this map.
 */
const STATUS_BADGE: Record<
  TaskStatus,
  { glyph: string; tone: "success" | "warning" | "primary" | "textMuted" | "error" }
> = {
  done: { glyph: "●", tone: "success" },
  in_review: { glyph: "◐", tone: "warning" },
  in_progress: { glyph: "●", tone: "primary" },
  backlog: { glyph: "○", tone: "textMuted" },
  canceled: { glyph: "✕", tone: "textMuted" },
  error: { glyph: "✕", tone: "error" },
}

/**
 * Tab labels for the view switcher. Order matches the `SidebarView`
 * union; the `[` / `]` keys cycle within this list (currently 2 entries).
 */
const VIEW_TABS: ReadonlyArray<{ view: SidebarView; label: string }> = [
  { view: "active", label: "Working session" },
  { view: "archived", label: "Archives" },
]

export function Sidebar(props: SidebarProps) {
  const { theme } = useTheme()

  const focusedAccessor = () => (props.focused ? props.focused() : true)

  // Active view; default to the working session. `[` / `]` cycle
  // through `VIEW_TABS`.
  const [view, setView] = createSignal<SidebarView>("active")

  // Filtered, flat row list for the active view. Recomputes only when
  // the upstream tasks accessor or the view changes.
  const rows = createMemo(() => buildRows(props.tasks(), view()))
  const flatIds = createMemo(() => flattenIds(rows()))

  const [cursorIndex, setCursorIndex] = createSignal<number>(-1)

  // Sync cursor from external selectedId. Deps are *only* the selected
  // id and the flat id list — we read `cursorIndex()` inside via
  // `untrack` so cursor moves from j/k don't refire this effect (which
  // would yank the cursor back to the selected task's position and
  // make navigation impossible).
  createEffect(
    on(
      () => [props.selectedId(), flatIds()] as const,
      ([id, ids]) => {
        const cur = untrack(cursorIndex)
        if (id === null) {
          if (cur === -1 && ids.length > 0) setCursorIndex(0)
          else if (cur >= ids.length) setCursorIndex(Math.max(0, ids.length - 1))
          else if (ids.length === 0) setCursorIndex(-1)
          return
        }
        const idx = ids.indexOf(id)
        if (idx >= 0 && idx !== cur) setCursorIndex(idx)
      },
    ),
  )

  // Reset cursor to 0 on view switch — the previous index is meaningless
  // against the new filtered list. `on` so we react only to view
  // changes, not to upstream task churn.
  createEffect(
    on(view, () => {
      const ids = flatIds()
      setCursorIndex(ids.length > 0 ? 0 : -1)
    }),
  )

  /**
   * Cycle the view by `delta` (-1 = `[` / left, +1 = `]` / right). Wraps:
   * `[` from the leftmost lands on the rightmost and vice versa. Today
   * there are 2 views so both directions toggle, but the cycle shape is
   * preserved so a future third view drops in without a binding rewrite.
   * (An earlier session briefly switched to clamp on a misread of the
   * spec — Jackson confirmed loop is the intended behavior; the apparent
   * "[ goes right" bug was a pinyin-IME swallow.)
   */
  function cycleView(delta: -1 | 1): void {
    const cur = view()
    const idx = VIEW_TABS.findIndex((t) => t.view === cur)
    if (idx < 0) return
    const next = (idx + delta + VIEW_TABS.length) % VIEW_TABS.length
    const target = VIEW_TABS[next]
    if (target) setView(target.view)
  }

  useSidebarBindings({
    focused: focusedAccessor,
    cursorIndex,
    setCursorIndex,
    flatTaskIds: flatIds,
    onSelect: (id) => props.onSelect(id),
    onDeleteRequest: (id) => props.onDeleteRequest?.(id),
    onArchiveRequest: (id) => props.onArchiveRequest?.(id),
    onRenameRequest: (id) => props.onRenameRequest?.(id),
    onViewSwitch: (delta) => cycleView(delta),
  })

  return (
    <box
      width={props.width ? props.width() : SIDEBAR_WIDTH}
      flexShrink={0}
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      {/* Header: "kobe" with a focus-aware ▌ marker matching PaneHeader's
         convention — green ▌ + green title when this pane has focus,
         dimmed when not. Keeps the focus signal consistent across all
         panes so the user's eye trains on a single visual pattern. */}
      <box flexDirection="row" gap={1} paddingBottom={1}>
        <Show when={focusedAccessor()} fallback={<text fg={theme.textMuted}> </text>}>
          <text fg={theme.success} attributes={TextAttributes.BOLD} wrapMode="none">
            ▌
          </text>
        </Show>
        <text fg={focusedAccessor() ? theme.success : theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
          kobe
        </text>
      </box>

      {/* View switcher: tab strip with the active view bracketed +
         emphasized. `[` / `]` toggles. */}
      <box flexDirection="row" gap={2} paddingBottom={1}>
        <For each={VIEW_TABS}>
          {(tab) => {
            const active = () => view() === tab.view
            return (
              <text
                fg={active() ? theme.primary : theme.textMuted}
                attributes={active() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
                onMouseUp={() => setView(tab.view)}
              >
                {active() ? `[ ${tab.label} ]` : tab.label}
              </text>
            )
          }}
        </For>
      </box>

      {/* Body: scrollable flat task list. Stretches with flexGrow so
         the footer always sits at the bottom. */}
      <scrollbox
        flexGrow={1}
        verticalScrollbarOptions={{
          trackOptions: {
            foregroundColor: "transparent",
          },
        }}
      >
        <box flexShrink={0} gap={0} paddingRight={1}>
          <For each={rows()}>
            {(row) => {
              const task = row.task
              const flatIndex = row.flatIndex
              const isCursor = () => flatIndex === cursorIndex()
              const isSelected = () => task.id === props.selectedId()
              const badge = STATUS_BADGE[task.status]
              const badgeColor = () => {
                switch (badge.tone) {
                  case "success":
                    return theme.success
                  case "warning":
                    return theme.warning
                  case "primary":
                    return theme.primary
                  case "error":
                    return theme.error
                  default:
                    return theme.textMuted
                }
              }
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  gap={1}
                  backgroundColor={isCursor() ? theme.primary : isSelected() ? theme.backgroundElement : undefined}
                  onMouseUp={() => props.onSelect(task.id)}
                >
                  <text fg={isCursor() ? theme.selectedListItemText : badgeColor()} wrapMode="none">
                    {badge.glyph}
                  </text>
                  <text
                    fg={isCursor() ? theme.selectedListItemText : theme.text}
                    attributes={isSelected() && !isCursor() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {task.title}
                  </text>
                </box>
              )
            }}
          </For>
          <Show when={flatIds().length === 0}>
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted}>{view() === "active" ? "No active tasks." : "No archived tasks."}</text>
            </box>
          </Show>
        </box>
      </scrollbox>

      {/* Footer: "+ New task" affordance. */}
      <box flexShrink={0} paddingTop={1}>
        <text fg={theme.textMuted} wrapMode="none" onMouseUp={() => props.onAddTask?.()}>
          + New task
        </text>
      </box>
    </box>
  )
}
