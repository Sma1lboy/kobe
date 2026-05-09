/**
 * Sidebar pane — TEMPORARY STREAM E PLACEHOLDER.
 *
 * Stream F (Wave 2 sibling) is the canonical owner of this file. The
 * version here exists only so Stream E's worktree can compile + run
 * tests in isolation. At merge time, the orchestrator picks Stream F's
 * version — this file is intentionally minimal so the diff against
 * F's full impl is obvious.
 *
 * Contract Stream E assumed (per the brief):
 *   <Sidebar tasks={() => Task[]} onSelect={(id: string) => void} />
 *
 * If Stream F's actual props diverge, the human merger reconciles
 * `src/tui/app.tsx`'s call site. Stream E does not unilaterally widen
 * scope into F's slice past this placeholder.
 *
 * Behavior:
 *   - Renders the task list flat (no status grouping yet — that's F).
 *   - Each row shows `title` + `status` so the G2 behavior test can
 *     visibly assert "demo task" appears after creation.
 *   - `j`/`k` and `up`/`down` move a local cursor; `enter` calls
 *     `onSelect(id)`. No focus management — the input in the chat
 *     pane will steal focus.
 *
 * Width: 42 chars (matches the lifted `<Sidebar>` shell from 0.2 and
 * the canonical layout target).
 */

import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo, createSignal } from "solid-js"
import type { Task } from "../../../types/task.ts"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"

const SIDEBAR_WIDTH = 42

export type SidebarProps = {
  /** Reactive accessor over the current task list. */
  tasks: () => Task[]
  /** Fired when the user selects a task. */
  onSelect?: (id: string) => void
  /** Currently selected task id (so the active row paints highlighted). */
  selectedId?: string
}

export function Sidebar(props: SidebarProps) {
  const { theme } = useTheme()
  const [cursor, setCursor] = createSignal(0)

  const ordered = createMemo(() => {
    // Sort: in_progress first, then backlog, then done/error/canceled.
    // Stable secondary sort by id (ulid is creation-time-sortable).
    const rank: Record<string, number> = {
      in_progress: 0,
      backlog: 1,
      in_review: 2,
      done: 3,
      error: 4,
      canceled: 5,
    }
    return props
      .tasks()
      .slice()
      .sort((a, b) => {
        const ra = rank[a.status] ?? 99
        const rb = rank[b.status] ?? 99
        if (ra !== rb) return ra - rb
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
  })

  function moveCursor(delta: number) {
    const len = ordered().length
    if (len === 0) return
    setCursor((c) => Math.max(0, Math.min(len - 1, c + delta)))
  }

  // Only arrow keys here, deliberately. Plain `j` / `k` would shadow
  // ctrl+k (the keymap's `matchKey` treats `key: "k"` as matching any
  // event with name="k" regardless of modifiers — Stream F's full
  // sidebar should special-case modifiers when it lands; this
  // placeholder avoids the ambiguity by sticking to arrows). We also
  // do NOT bind `return` here because the chat pane's input owns
  // enter; clicking a sidebar row works via onMouseUp instead.
  useBindings(() => ({
    bindings: [
      { key: "down", cmd: () => moveCursor(1) },
      { key: "up", cmd: () => moveCursor(-1) },
    ],
  }))

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      width={SIDEBAR_WIDTH}
      height="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={1}
    >
      <box paddingBottom={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Tasks
        </text>
        <text fg={theme.textMuted}>{ordered().length} total</text>
      </box>

      <Show
        when={ordered().length > 0}
        fallback={
          <box paddingTop={1}>
            <text fg={theme.textMuted}>No tasks yet. Press n.</text>
          </box>
        }
      >
        <scrollbox flexGrow={1}>
          <box paddingRight={1}>
            <For each={ordered()}>
              {(task, idx) => {
                const active = () => idx() === cursor() || task.id === props.selectedId
                return (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={active() ? theme.primary : undefined}
                    onMouseUp={() => props.onSelect?.(task.id)}
                  >
                    <text fg={active() ? theme.selectedListItemText : theme.text} wrapMode="none">
                      {task.title}
                    </text>
                    <text fg={active() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                      {task.status}
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </scrollbox>
      </Show>
    </box>
  )
}
