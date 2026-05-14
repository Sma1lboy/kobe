/**
 * Resume-session picker — kobe's analogue to claude-code's `/resume` UI.
 *
 * Shows every persisted engine session for the active task's worktree,
 * newest first. Selecting a row opens that session in a new chat tab via
 * `orchestrator.openSessionInTab` — or, if the same engine/session is
 * already attached to one of the task's existing tabs, jumps to that tab
 * instead. The orchestrator handles the dedup; this component only picks.
 *
 * Visual + interaction grammar borrows from claude-code's
 * `LogSelector.tsx` (`refs/claude-code/src/components/LogSelector.tsx`):
 *
 *   - one row per session, two-column layout: timestamp + preview
 *   - j/k or arrow keys to move, enter to select, esc to dismiss
 *     (esc is handled higher up by `DialogProvider`'s own binding stack)
 *   - footer key-hint row so first-time users discover the chord without
 *     opening F1
 *
 * Data source contract: kobe maintains NO parallel session index. The
 * list is recomputed from each registered engine's durable history every
 * time the picker opens, so a session opened by raw engine CLIs outside
 * kobe still appears.
 */

import type { KobeOrchestrator } from "@/client/remote-orchestrator"
import type { SessionMeta } from "@/types/engine"
import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"
import { engineLabel } from "./resume-dialog-labels"

/** Sentinel string the behavior test asserts on. */
export const RESUME_DIALOG_TITLE = "kobe — resume session"

/** Empty-state copy when the worktree has no persisted sessions yet. */
export const RESUME_DIALOG_EMPTY = "No prior sessions in this task's worktree."

/** Footer hint — mirrors `help-dialog`'s "esc to dismiss" cue. */
export const RESUME_DIALOG_FOOTER = "j/k or ↑↓ navigate • enter resume • esc dismiss"

export interface ResumeDialogProps {
  orchestrator: KobeOrchestrator
  taskId: string
}

export function ResumeDialog(props: ResumeDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  // createResource so the JSONL scan happens off the render path. The
  // picker shows a "Loading…" line for the brief tick before the I/O
  // completes; for a typical worktree (handful of sessions) this is
  // imperceptible, but it keeps the UI honest if a project ever
  // accumulates hundreds of sessions.
  const [sessions] = createResource<readonly SessionMeta[]>(async () => {
    return props.orchestrator.listSessions(props.taskId)
  })

  const [cursor, setCursor] = createSignal(0)

  const rows = createMemo<readonly SessionMeta[]>(() => sessions() ?? [])
  const clampCursor = (delta: number) => {
    const len = rows().length
    if (len === 0) return
    setCursor((c) => Math.max(0, Math.min(len - 1, c + delta)))
  }

  function commit(): void {
    const picked = rows()[cursor()]
    if (!picked) return
    // openSessionInTab handles dedup: same sessionId already on a tab
    // → activates that tab; otherwise creates a new tab seeded with
    // the sessionId (single store.update so Chat.tsx's reactive subscribe
    // loop sees sessionId on first observation and fires readHistory).
    void props.orchestrator
      .openSessionInTab(props.taskId, picked.sessionId, {
        title: deriveTabTitle(picked),
        vendor: picked.vendor,
      })
      .then(() => dialog.clear())
  }

  useBindings(() => ({
    bindings: [
      { key: "j", cmd: () => clampCursor(1) },
      { key: "down", cmd: () => clampCursor(1) },
      { key: "k", cmd: () => clampCursor(-1) },
      { key: "up", cmd: () => clampCursor(-1) },
      { key: "enter", cmd: () => commit() },
      { key: "return", cmd: () => commit() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexShrink={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {RESUME_DIALOG_TITLE}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show
        when={rows().length > 0}
        fallback={
          <box paddingTop={1} paddingBottom={1}>
            <text fg={theme.textMuted}>{sessions.loading ? "Loading sessions…" : RESUME_DIALOG_EMPTY}</text>
          </box>
        }
      >
        <scrollbox
          flexShrink={1}
          flexGrow={1}
          stickyScroll={false}
          verticalScrollbarOptions={{
            trackOptions: { backgroundColor: theme.backgroundDialog, foregroundColor: theme.borderActive },
          }}
        >
          <box paddingBottom={1} gap={0} paddingRight={1}>
            <For each={rows()}>
              {(row, idx) => {
                const selected = () => idx() === cursor()
                return (
                  <box
                    flexDirection="row"
                    gap={2}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={selected() ? theme.primary : undefined}
                    onMouseDown={() => setCursor(idx())}
                    onMouseUp={() => commit()}
                  >
                    <box width={12} flexShrink={0}>
                      <text fg={selected() ? theme.selectedListItemText : theme.textMuted}>
                        {formatRelative(row.mtimeMs)}
                      </text>
                    </box>
                    <box flexGrow={1} flexShrink={1}>
                      <text fg={selected() ? theme.selectedListItemText : theme.text} wrapMode="none">
                        {row.firstUserMessage ?? "(no user message)"}
                      </text>
                    </box>
                    <box width={10} flexShrink={0}>
                      <text fg={selected() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                        {engineLabel(row)}
                      </text>
                    </box>
                    <box width={10} flexShrink={0}>
                      <text fg={selected() ? theme.selectedListItemText : theme.textMuted}>
                        {`#${row.sessionId.slice(-8)}`}
                      </text>
                    </box>
                  </box>
                )
              }}
            </For>
          </box>
        </scrollbox>
      </Show>
      <box paddingTop={0} paddingBottom={1}>
        <text fg={theme.textMuted}>{RESUME_DIALOG_FOOTER}</text>
      </box>
    </box>
  )
}

/**
 * Convenience opener — pushes the resume dialog onto the dialog stack.
 * Used by the global `chat.session.resume` chord.
 */
ResumeDialog.show = (dialog: DialogContext, orchestrator: KobeOrchestrator, taskId: string): void => {
  dialog.replace(() => <ResumeDialog orchestrator={orchestrator} taskId={taskId} />)
}

/**
 * Render a relative time like `5m ago` / `3h ago` / `2d ago` / `Mar 4`.
 * Mirrors GitHub's terse style — long enough to disambiguate today vs
 * last week, short enough to fit a 12-cell column. Falls back to
 * `?` when mtime is 0 (read-failed marker from the sessions scanner).
 */
export function formatRelative(mtimeMs: number, now: number = Date.now()): string {
  if (mtimeMs <= 0) return "?"
  const deltaSec = Math.max(0, Math.floor((now - mtimeMs) / 1000))
  if (deltaSec < 60) return "just now"
  const min = Math.floor(deltaSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 7) return `${days}d ago`
  // For older entries show absolute month + day. ISO YYYY-MM-DD takes
  // 10 chars and edges past the 12-cell column cap; abbreviated month
  // (Mar 4) reads better and stays within budget.
  const d = new Date(mtimeMs)
  const month = d.toLocaleString("en-US", { month: "short" })
  return `${month} ${d.getDate()}`
}

/**
 * Build a tab-title string from a session's first user message. Used
 * when the picker opens a session in a fresh tab. Sidebar / tab strip
 * truncate further; this just gives the orchestrator something more
 * informative than the default "Tab N" placeholder.
 */
function deriveTabTitle(session: SessionMeta): string | undefined {
  const preview = session.firstUserMessage?.trim()
  if (!preview) return undefined
  // First line (sidebar tabs render single-line). Hard cap at 40 chars
  // so a multi-paragraph paste doesn't bloat the manifest.
  const firstLine = preview.split("\n", 1)[0] ?? preview
  return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine
}
