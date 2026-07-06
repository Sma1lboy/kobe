/**
 * BoardPeek — the board's side drawer onto one task's LIVE session: the
 * engine PTY and the read-only transcript, without leaving the board.
 *
 * The drawer attaches by the task's WORKSPACE engine tab id
 * (ensureEngineTab), so peek and workspace are two views of one server-side
 * PTY — the sidecar fans output to every attached socket, and a
 * drawer-private id would instead spawn a second engine instance. Closing
 * the drawer only detaches the WebSocket: the PTY survives server-side
 * (/pty/close stays reserved for real tab closes), so peeking never kills
 * a session. The converse holds too: peeking a task whose session ISN'T
 * running starts it (worktree + engine spawn — same as opening the
 * workspace vendor tab), which the eye button's tooltip discloses
 * (docs/design/web-kanban.md R9/M4).
 */

import { ClipboardCheck, ExternalLink, GitPullRequest, X } from "lucide-react"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { activityColor, activityLabel } from "../lib/activity.ts"
import { ensureEngineTab } from "../lib/tabs.ts"
import type { EngineState, Task } from "../lib/types.ts"
import { useFocusTrap } from "../lib/use-focus-trap.ts"
import { ChatTranscript } from "./ChatTranscript.tsx"

// xterm is the app's heaviest dependency — keep it out of the board chunk
// until a peek actually opens (the WorkspaceTabs precedent).
const ChatTerminal = lazy(() =>
  import("./ChatTerminal.tsx").then((m) => ({ default: m.ChatTerminal })),
)

type PeekView = "engine" | "transcript"

export function BoardPeek({
  task,
  engine,
  onClose,
  onOpenWorkspace,
  onReview,
  onCreatePr,
}: {
  task: Task
  engine?: EngineState
  onClose: () => void
  onOpenWorkspace: () => void
  onReview?: () => void
  onCreatePr?: () => void
}) {
  const [view, setView] = useState<PeekView>("engine")
  // Resolved once per drawer open; reopening resolves the same id again, so
  // the PTY's scrollback ring replays the session where it left off.
  const [engineTabId] = useState(() => ensureEngineTab(task.id))
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  // Esc closes the drawer — except while the terminal owns the keyboard
  // (xterm's hidden textarea) or the user is typing in a field, where Esc
  // must reach the engine / clear the field instead.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      const t = event.target as HTMLElement | null
      if (t?.closest(".xterm")) return
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const label = activityLabel(engine?.state)
  const tabClass = (active: boolean): string =>
    `border-b-2 px-2 py-1.5 text-[11px] transition-colors ${
      active
        ? "border-primary text-fg"
        : "border-transparent text-muted hover:text-fg"
    }`

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close peek"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Session peek: ${task.title || task.branch || task.id}`}
        className="relative flex h-full w-[640px] max-w-[92vw] flex-col border-l border-line bg-bg shadow-2xl"
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityColor(engine?.state)}`}
          />
          <span className="min-w-0 truncate text-[13px] text-fg">
            {task.title || task.branch || task.id}
          </span>
          <span className="hidden min-w-0 truncate font-mono text-[11px] text-subtle sm:inline">
            {task.branch}
          </span>
          {label && (
            <span className="shrink-0 text-[11px] text-muted">{label}</span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {onReview && (
              <button
                type="button"
                onClick={onReview}
                className="flex items-center gap-1 text-muted transition-colors hover:text-fg"
                title="Review → done if it passes"
              >
                <ClipboardCheck size={13} strokeWidth={1.8} />
                <span className="text-[11px]">Review</span>
              </button>
            )}
            {onCreatePr && (
              <button
                type="button"
                onClick={onCreatePr}
                className="flex items-center gap-1 text-muted transition-colors hover:text-fg"
                title="Open a PR for this branch"
              >
                <GitPullRequest size={13} strokeWidth={1.8} />
                <span className="text-[11px]">PR</span>
              </button>
            )}
            <button
              type="button"
              onClick={onOpenWorkspace}
              className="flex items-center gap-1 text-muted transition-colors hover:text-fg"
              title="Open in workspace"
            >
              <ExternalLink size={13} strokeWidth={1.8} />
              <span className="text-[11px]">Workspace</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex items-center text-muted transition-colors hover:text-fg"
              aria-label="Close peek"
              title="Close (Esc)"
            >
              <X size={15} strokeWidth={1.8} />
            </button>
          </div>
        </header>
        <nav className="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
          <button
            type="button"
            onClick={() => setView("engine")}
            className={tabClass(view === "engine")}
          >
            Engine
          </button>
          <button
            type="button"
            onClick={() => setView("transcript")}
            className={tabClass(view === "transcript")}
          >
            Transcript
          </button>
        </nav>
        <div className="min-h-0 flex-1">
          {view === "engine" ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-[12px] text-subtle">
                  Loading terminal…
                </div>
              }
            >
              <ChatTerminal
                key={engineTabId}
                tabId={engineTabId}
                taskId={task.id}
                mode="engine"
              />
            </Suspense>
          ) : (
            <ChatTranscript
              worktreePath={task.worktreePath}
              vendor={task.vendor ?? "claude"}
              title={task.title || task.branch}
            />
          )}
        </div>
      </div>
    </div>
  )
}
