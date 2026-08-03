/**
 * ChatShell — a full-page "the product is a chat app" experiment (/chat).
 * Instead of the workspace's terminal-first tabs, this renders one task's
 * engine session as a GUI conversation: left session rail, center structured
 * transcript + prompt composer, right session-info panel.
 *
 * Nothing here invents a new data path: the transcript is ChatTranscript
 * (engine-history routes), the composer drives the task's engine PTY via the
 * board's spawn-on-send contract (ensureEngineTab + sendPtyText), and the
 * info panel reads the daemon snapshot store. A collapsible terminal drawer
 * attaches a real xterm to the SAME PTY for anything the GUI can't express
 * (permission dialogs, /commands with menus) — it auto-opens when the engine
 * reports it needs input.
 */

import {
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  Search,
  SquareTerminal,
} from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { activityLabel, activityMeta } from "../lib/activity.ts"
import { useEngines } from "../lib/engines.ts"
import { tailPath } from "../lib/path-format.ts"
import { useAppState } from "../lib/store.ts"
import { ensureEngineTab } from "../lib/tabs.ts"
import { matchesTask } from "../lib/task-list.ts"
import { sendPtyText } from "../lib/terminal.ts"
import { relativeTime } from "../lib/time.ts"
import { formatError, pushToast } from "../lib/toast.ts"
import type { EngineState, Task } from "../lib/types.ts"
import { engineLabel, resolveVendor } from "../lib/vendor.ts"
import { ChatTranscript } from "./ChatTranscript.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { Toasts } from "./Toasts.tsx"

const ChatTerminal = lazy(() =>
  import("./ChatTerminal.tsx").then((m) => ({ default: m.ChatTerminal })),
)

function SessionRow({
  task,
  engine,
  active,
  onClick,
}: {
  task: Task
  engine: EngineState | undefined
  active: boolean
  onClick: () => void
}) {
  const meta = activityMeta(engine?.state)
  const updated = relativeTime(task.updatedAt || task.createdAt)
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
        active ? "bg-inset" : "hover:bg-surface"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.color}`} />
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${active ? "text-fg" : "text-fg/85"}`}
        >
          {task.title || task.branch || task.repo}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[11px] text-subtle">
        <span className="min-w-0 truncate">{task.branch || "~"}</span>
        {updated && <span className="ml-auto shrink-0">{updated}</span>}
      </div>
    </button>
  )
}

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
          The engine is waiting on an interactive prompt — answer it in the
          terminal drawer below.
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
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showTerminal, setShowTerminal] = useState(false)

  const live = useMemo(() => tasks.filter((t) => !t.archived), [tasks])
  const shown = useMemo(
    () => live.filter((t) => matchesTask(t, query)),
    [live, query],
  )
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

  // The GUI composer can't answer interactive dialogs — pop the real terminal
  // when the engine blocks on one.
  useEffect(() => {
    if (needsInput) setShowTerminal(true)
  }, [needsInput])

  const vendor = resolveVendor(selected?.vendor)
  const engineName = engineLabel(engines, selected?.vendor)
  // Same tab id the workspace uses — chat view and workspace share one PTY.
  // ensureEngineTab mutates the tabs store, so resolve it in an effect (not
  // during render), and only once the drawer actually needs a terminal.
  const selectedTaskId = selected?.id ?? null
  const [tabId, setTabId] = useState<string | null>(null)
  useEffect(() => {
    if (showTerminal && selectedTaskId)
      setTabId(ensureEngineTab(selectedTaskId))
    else setTabId(null)
  }, [showTerminal, selectedTaskId])

  return (
    <div className="flex h-full flex-col bg-bg">
      <DaemonBanner />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
            <span className="font-mono text-[13px] font-bold text-primary">
              [kobe]
            </span>
            <span className="text-[11px] text-subtle">chat</span>
          </div>
          <div className="m-2 flex items-center gap-2 rounded-md bg-inset px-2 py-1.5">
            <Search
              size={12}
              strokeWidth={2}
              className="shrink-0 text-subtle"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-fg placeholder:text-subtle focus:outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {shown.length === 0 ? (
              <div className="px-3 py-4 text-[12px] text-subtle">
                {live.length === 0
                  ? "No tasks yet — create one in the workspace."
                  : "No sessions match."}
              </div>
            ) : (
              shown.map((task) => (
                <SessionRow
                  key={task.id}
                  task={task}
                  engine={engineStates[task.id]}
                  active={task.id === selected?.id}
                  onClick={() => setSelectedId(task.id)}
                />
              ))
            )}
          </div>
        </aside>

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
              <button
                type="button"
                onClick={() => setShowTerminal((cur) => !cur)}
                className={`ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                  showTerminal
                    ? "border-line-active bg-inset text-fg"
                    : "border-line text-subtle hover:text-fg"
                }`}
                title="Toggle the raw terminal for this session"
              >
                <SquareTerminal size={12} strokeWidth={2} />
                Terminal
                {showTerminal ? (
                  <ChevronDown size={11} />
                ) : (
                  <ChevronUp size={11} />
                )}
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <ChatTranscript
                key={selected.id}
                worktreePath={selected.worktreePath || null}
                vendor={vendor}
              />
            </div>
            {showTerminal && tabId && (
              <div className="h-72 shrink-0 border-t border-line">
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
            <Composer taskId={selected.id} needsInput={needsInput} />
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
