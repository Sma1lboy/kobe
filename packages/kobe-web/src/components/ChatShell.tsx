/**
 * ChatShell — kobe as a windowed TERMINAL app (/chat, hosted by the
 * kobe-desktop Electron shell). The center IS a real terminal: the task's
 * engine PTY runs the actual engine CLI (claude), fully interactive — its
 * own input line, /command menus, and permission dialogs all live there.
 *
 * What this surface adds is engine-specific rendering ON TOP of that
 * terminal: a "Chat" view that re-renders the SAME session's conversation
 * as GUI rows (ChatTranscript over the engine-history routes) instead of
 * scrollback. The terminal stays mounted (hidden, PTY attached) while the
 * chat view shows, so flipping back is instant and loss-free; a permission
 * prompt auto-snaps to the terminal because only the real CLI can answer it.
 *
 * Left rail mirrors the TUI tree sidebar; right is a session-info panel from
 * the daemon snapshot. One PTY per task tab — the same one the workspace
 * vendor tab attaches.
 */

import { CornerDownLeft, MessagesSquare, SquareTerminal } from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { activityLabel, activityMeta } from "../lib/activity.ts"
import { useEngines } from "../lib/engines.ts"
import { tailPath } from "../lib/path-format.ts"
import { useAppState } from "../lib/store.ts"
import { ensureEngineTab } from "../lib/tabs.ts"
import { sendPtyText } from "../lib/terminal.ts"
import { relativeTime } from "../lib/time.ts"
import { formatError, pushToast } from "../lib/toast.ts"
import type { EngineState, Task } from "../lib/types.ts"
import { engineLabel, resolveVendor } from "../lib/vendor.ts"
import { ChatSidebarTree } from "./ChatSidebarTree.tsx"
import { ChatTranscript } from "./ChatTranscript.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { Toasts } from "./Toasts.tsx"

const ChatTerminal = lazy(() =>
  import("./ChatTerminal.tsx").then((m) => ({ default: m.ChatTerminal })),
)

type CenterView = "terminal" | "chat"

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 px-3 py-1">
      <span className="w-16 shrink-0 text-[11px] text-subtle">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted">
        {value}
      </span>
    </div>
  )
}

function InfoHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
      {children}
    </div>
  )
}

function InfoPanel({
  task,
  engine,
  engineName,
  changes,
}: {
  task: Task
  engine: EngineState | undefined
  engineName: string
  changes: { added: number; deleted: number } | undefined
}) {
  const state = activityLabel(engine?.state) || "idle"
  return (
    <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface lg:flex">
      <InfoHeader>Session</InfoHeader>
      <InfoRow label="Agent" value={engineName} />
      <InfoRow label="Status" value={state} />
      <InfoRow label="Path" value={tailPath(task.worktreePath || "~", 28)} />
      <InfoHeader>Git</InfoHeader>
      <InfoRow label="Branch" value={task.branch || "—"} />
      <InfoRow
        label="Changes"
        value={changes ? `+${changes.added} −${changes.deleted}` : "clean"}
      />
      {task.prStatus?.number != null && (
        <InfoRow
          label="PR"
          value={`#${task.prStatus.number} ${task.prStatus.lifecycle ?? ""}`}
        />
      )}
      <InfoHeader>Task</InfoHeader>
      <InfoRow label="Kind" value={task.kind} />
      <InfoRow label="Repo" value={tailPath(task.repo, 28)} />
      <InfoRow label="Created" value={relativeTime(task.createdAt) || "—"} />
    </aside>
  )
}

/** The chat view's prompt box — pastes into the same engine PTY the terminal
 *  view shows (spawn-on-send). The terminal view needs none of this: the
 *  CLI's own input line is right there. */
function Composer({
  taskId,
  needsInput,
}: {
  taskId: string
  needsInput: boolean
}) {
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const tabId = ensureEngineTab(taskId)
      const { spawned } = await sendPtyText(tabId, taskId, text)
      if (spawned) pushToast("info", "Engine started for this session")
      setDraft("")
    } catch (err) {
      pushToast("error", formatError("send prompt", err))
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      className="shrink-0 border-t border-line bg-surface px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      {needsInput && (
        <div className="mb-2 text-[11px] text-kobe-blue">
          The engine is waiting on an interactive prompt — switch to the
          Terminal view to answer it.
        </div>
      )}
      <div className="flex items-end gap-2 rounded-lg border border-line bg-bg px-3 py-2 focus-within:border-line-active">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder="Send a prompt — Enter sends, Shift+Enter newline"
          rows={Math.min(6, Math.max(1, draft.split("\n").length))}
          className="min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-fg placeholder:text-subtle focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-bg transition-opacity disabled:opacity-30"
          title="Send"
          aria-label="Send prompt"
        >
          <CornerDownLeft size={13} strokeWidth={2.2} />
        </button>
      </div>
    </form>
  )
}

export function ChatShell() {
  const { tasks, activeTaskId, engineStates, worktreeChanges } = useAppState()
  const engines = useEngines()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Terminal first — the native CLI is the product; "chat" is the
  // specialized rendering of the same session.
  const [view, setView] = useState<CenterView>("terminal")

  const live = useMemo(() => tasks.filter((t) => !t.archived), [tasks])
  const selected =
    live.find((t) => t.id === selectedId) ??
    live.find((t) => t.id === activeTaskId) ??
    live[0] ??
    null

  const engine = selected ? engineStates[selected.id] : undefined
  // The daemon's activity registry emits "permission_needed"; older web code
  // (activity.ts) still matches "waiting_permission" — accept both here.
  const needsInput =
    engine?.state === "waiting_permission" ||
    engine?.state === "permission_needed"

  // Only the real CLI can answer its interactive dialogs — snap the center
  // back to the terminal when the engine blocks on one.
  useEffect(() => {
    if (needsInput) setView("terminal")
  }, [needsInput])

  const vendor = resolveVendor(selected?.vendor)
  const engineName = engineLabel(engines, selected?.vendor)
  // Same tab id the workspace vendor tab uses — both surfaces share one PTY.
  // ensureEngineTab mutates the tabs store, so resolve it in an effect (not
  // during render).
  const selectedTaskId = selected?.id ?? null
  const [tabId, setTabId] = useState<string | null>(null)
  useEffect(() => {
    setTabId(selectedTaskId ? ensureEngineTab(selectedTaskId) : null)
  }, [selectedTaskId])

  const viewTab = (
    target: CenterView,
    label: string,
    icon: React.ReactNode,
  ) => (
    <button
      type="button"
      onClick={() => setView(target)}
      aria-pressed={view === target}
      className={`flex items-center gap-1.5 border-l border-line px-2 py-1 text-[11px] transition-colors first:border-l-0 ${
        view === target
          ? "border-line-active bg-inset text-fg"
          : "text-subtle hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div className="flex h-full flex-col bg-bg">
      <DaemonBanner />
      <div className="flex min-h-0 flex-1">
        <ChatSidebarTree
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
        />

        {selected ? (
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
              <span className="min-w-0 truncate text-[13px] text-fg">
                {selected.title || selected.branch}
              </span>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityMeta(engine?.state).color}`}
              />
              <span className="text-[11px] text-subtle">
                {activityLabel(engine?.state)}
              </span>
              <div className="ml-auto flex items-center overflow-hidden rounded-sm border border-line">
                {viewTab(
                  "terminal",
                  "Terminal",
                  <SquareTerminal size={12} strokeWidth={2} />,
                )}
                {viewTab(
                  "chat",
                  "Chat",
                  <MessagesSquare size={12} strokeWidth={2} />,
                )}
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
              {/* The terminal stays mounted while the chat view shows — the
                  PTY connection and scrollback survive the toggle. */}
              {tabId && (
                <div
                  className={view === "terminal" ? "h-full" : "hidden"}
                  aria-hidden={view !== "terminal"}
                >
                  <Suspense
                    fallback={
                      <div className="flex h-full items-center justify-center text-[12px] text-subtle">
                        Attaching terminal…
                      </div>
                    }
                  >
                    <ChatTerminal
                      key={tabId}
                      tabId={tabId}
                      taskId={selected.id}
                      mode="engine"
                    />
                  </Suspense>
                </div>
              )}
              {view === "chat" && (
                <div className="flex h-full flex-col">
                  <div className="min-h-0 flex-1">
                    <ChatTranscript
                      key={selected.id}
                      worktreePath={selected.worktreePath || null}
                      vendor={vendor}
                    />
                  </div>
                  <Composer taskId={selected.id} needsInput={needsInput} />
                </div>
              )}
            </div>
          </main>
        ) : (
          <main className="flex flex-1 items-center justify-center text-[12px] text-subtle">
            No sessions — create a task first.
          </main>
        )}

        {selected && (
          <InfoPanel
            task={selected}
            engine={engine}
            engineName={engineName}
            changes={
              selected.worktreePath
                ? worktreeChanges[selected.worktreePath]
                : undefined
            }
          />
        )}
      </div>
      <Toasts />
    </div>
  )
}
