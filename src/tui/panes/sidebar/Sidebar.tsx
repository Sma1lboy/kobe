/**
 * kobe sidebar pane (Stream F + Wave 4 W4.A).
 *
 * Renders the **repo-grouped** task list inside a 42-cell-wide column.
 * Wave 4 dropped the 5-status grouping per HANDOFF.md §"Direction shift"
 * #1 + #2 — kobe doesn't manage PR-merge state and the In progress / In
 * review / Backlog / Done / Canceled / Error shape didn't fit. Layout:
 *
 *   kobe
 *
 *   my-frontend  3
 *     ● fix login redirect bug
 *     ○ refactor auth service
 *     ○ add password reset
 *
 *   api-server   1
 *     ● migrate to fastify
 *
 *   + Add repo
 *
 * The 42-cell sidebar width is a documented hardcode (CLAUDE.md
 * "flex-first, hardcode last"): convention rationale — matches
 * opencode/agent-deck precedent for "history rail" panes. We import the
 * `SIDEBAR_WIDTH` constant from the lifted opencode primitive
 * (`src/tui/component/sidebar.tsx`) so the convention has one source
 * of truth across the codebase.
 *
 * Status badges (●○) still render on per-task rows as a visual hint of
 * the underlying `task.status` value (which stays on disk untouched —
 * the orchestrator's concurrency cap depends on it; a future
 * experimental flag will resurrect a status-grouped view), but the
 * sidebar no longer groups, sorts, or re-orders by status.
 *
 * Cursor / nav: a Solid signal `cursorIndex` indexes the *flat*
 * navigable task list (repo headers are NOT navigable; j/k step over
 * them transparently). `enter` selects the cursor row, `d` requests
 * delete via the parent-owned confirm dialog, `g g` (chord) jumps to
 * top, `G` jumps to bottom — see `keys.ts` + `controller.ts`. Single-
 * repo collapse: not implemented; the repo header always renders even
 * when there's only one repo. This keeps layout stable as the user
 * adds repos and makes the multi-repo nature of kobe visible from
 * keystroke one. (Future polish could collapse the header in single-
 * repo mode if Jackson asks.)
 *
 * `+ Add repo` affordance: rendered as the footer row. Pressing `n` or
 * `ctrl+n` (the existing global bindings) opens the new-task dialog,
 * which doubles as the new-repo path: typing a fresh repo path in the
 * dialog's repo field creates a session under that repo. Wiring the
 * mouse click on the footer to the same handler is left as a Wave 4
 * follow-up — clicking the row is currently a no-op visual element.
 *
 * Reactivity: every prop is an `Accessor`. We never `.map()` arrays in
 * JSX — `For` is used so Solid keeps the row list reactive. The
 * grouping recomputes via `createMemo` only when the upstream `tasks`
 * accessor changes; cursor changes don't re-group.
 *
 * Focus: `props.focused` defaults to `() => true` so embedders that
 * don't yet thread the focus signal still get a working sidebar.
 */

import type { Task, TaskStatus } from "@/types"
import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { SIDEBAR_WIDTH } from "../../component/sidebar"
import { useTheme } from "../../context/theme"
import { buildRows, flattenIds } from "./groups"
import { useSidebarBindings } from "./keys"

/**
 * Props for the sidebar pane. Lives in this file (not the barrel) to
 * keep `index.ts` a pure re-export with no inline type definitions —
 * the barrel imports from here, not the other way around, so no circular
 * dependency exists at module-init time.
 */
export type SidebarProps = {
  tasks: Accessor<readonly Task[]>
  selectedId: Accessor<string | null>
  onSelect: (id: string) => void
  focused?: Accessor<boolean>
  /**
   * Delete-request callback. Fires when the user presses `d` with the
   * cursor on a task. The sidebar does NOT show a confirm — the parent
   * (app.tsx Shell) owns the dialog flow and the orchestrator call so
   * the sidebar stays a stateless view. Optional: tests and any future
   * stripped-down embedder can leave delete unwired.
   */
  onDeleteRequest?: (taskId: string) => void
  /**
   * Optional callback for the `+ Add repo` footer affordance. When
   * provided, clicking the footer row invokes this — typically the
   * parent's existing new-task flow handler. Left undefined this
   * stream; the global `n` / `ctrl+n` bindings remain the canonical
   * entry point.
   */
  onAddRepo?: () => void
}

/**
 * Glyph + theme-token name for each status's badge. We render the glyph
 * with the theme colour resolved at render time; storing the *tone* (not
 * the resolved RGBA) keeps badges reactive to theme switches.
 *
 * The badge is now a per-task hint only — no grouping reads from this
 * map. Token choice rationale:
 *   - `done` → success (green check)
 *   - `in_review` → warning (amber, awaits user)
 *   - `in_progress` → primary (themeful "active" colour)
 *   - `backlog` → textMuted (deferred)
 *   - `canceled` → textMuted (no longer relevant)
 *   - `error` → error (red)
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

// Row layout helpers (`buildRows`, `flattenIds`) live in `groups.ts` so
// they are testable without spinning up the renderer. They're imported
// at the top of this file.

export function Sidebar(props: SidebarProps) {
  const { theme } = useTheme()

  // Default `focused` accessor — see file header. Reading through this
  // shim makes "no focused prop passed" mean "always focused" without
  // re-creating a signal on every render.
  const focusedAccessor = () => (props.focused ? props.focused() : true)

  // Memoize the flat row list and the navigable id list. Solid will
  // re-run these only when `props.tasks()` changes — cursor moves don't
  // re-group, header expansion doesn't re-group.
  const rows = createMemo(() => buildRows(props.tasks()))
  const flatIds = createMemo(() => flattenIds(rows()))

  // Cursor index into `flatIds`. -1 when the list is empty. Synced from
  // `props.selectedId` on first render and whenever the parent changes
  // it from outside; keystroke movement updates the cursor locally and
  // we emit `onSelect` when the user presses enter (we do NOT emit
  // `onSelect` on every j/k press — that would be a different semantic;
  // the brief separates "cursor position" from "selection").
  const [cursorIndex, setCursorIndex] = createSignal<number>(-1)

  // Sync cursor from external selectedId. Runs whenever props.selectedId
  // or the flat id list changes; reactive on both inputs.
  createEffect(() => {
    const id = props.selectedId()
    const ids = flatIds()
    if (id === null) {
      // Move cursor onto the first navigable row when tasks first
      // arrive; otherwise leave it where it is so j/k position is
      // preserved across upstream prop churn that doesn't change ids.
      if (cursorIndex() === -1 && ids.length > 0) setCursorIndex(0)
      if (cursorIndex() >= ids.length) setCursorIndex(Math.max(0, ids.length - 1))
      if (ids.length === 0) setCursorIndex(-1)
      return
    }
    const idx = ids.indexOf(id)
    if (idx >= 0 && idx !== cursorIndex()) setCursorIndex(idx)
  })

  // Register pane-local bindings. The hook closes over our cursor
  // signal — `useBindings` re-evaluates the config on every keypress, so
  // toggling `focused` from outside immediately disables our keys.
  useSidebarBindings({
    focused: focusedAccessor,
    cursorIndex,
    setCursorIndex,
    flatTaskIds: flatIds,
    onSelect: (id) => props.onSelect(id),
    onDeleteRequest: (id) => props.onDeleteRequest?.(id),
  })

  return (
    <box
      width={SIDEBAR_WIDTH}
      flexShrink={0}
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      {/* Header: just "kobe". The previous version label was visual
         clutter — it changes per-build, doesn't help the user navigate,
         and there's a CLAUDE.md file at the repo root for builds. */}
      <box flexDirection="row" paddingBottom={1}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          kobe
        </text>
      </box>

      {/* Body: scrollable repo-grouped task list. Stretching with
         flexGrow so the footer always sits at the bottom. */}
      <scrollbox
        flexGrow={1}
        verticalScrollbarOptions={{
          trackOptions: {
            // Transparent track + thumb → invisible scrollbar; still
            // scrollable but doesn't clutter the see-through aesthetic.
            foregroundColor: "transparent",
          },
        }}
      >
        <box flexShrink={0} gap={0} paddingRight={1}>
          <For each={rows()}>
            {(row) => {
              if (row.kind === "repo-header") {
                const label = row.label
                const count = row.count
                return (
                  <box
                    flexDirection="row"
                    justifyContent="space-between"
                    paddingTop={1}
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
                      {label}
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {String(count)}
                    </text>
                  </box>
                )
              }
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
              <text fg={theme.textMuted}>No tasks yet.</text>
            </box>
          </Show>
        </box>
      </scrollbox>

      {/* Footer: "+ Add repo" affordance. Triggers `onAddRepo` if the
         parent wires it; otherwise it's a visual placeholder and the
         user opens the new-task dialog via the global `n`/`ctrl+n`
         bindings. */}
      <box flexShrink={0} paddingTop={1}>
        <text fg={theme.textMuted} wrapMode="none" onMouseUp={() => props.onAddRepo?.()}>
          + Add repo
        </text>
      </box>
    </box>
  )
}
