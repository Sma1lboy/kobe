/**
 * ChatShell — kobe as a windowed TERMINAL app (/chat, hosted by the
 * kobe-desktop Electron shell). ONE surface, no modes: the task's engine
 * PTY runs the real CLI, and what you SEE is its screen translated to HTML
 * (TtyBlocksView over lib/claude-tty.ts) with the GUI composer standing in
 * for the native input row. The raw xterm stays mounted underneath as the
 * data source and takes over the pixels automatically only while a native
 * dialog owns the screen (permission prompt, menu) — answer it, and the
 * translated render returns. No view toggle, no second transcript.
 *
 * Left rail mirrors the TUI tree sidebar; right is a collapsed-by-default
 * Changes placeholder. One PTY per task tab — the same one the workspace
 * vendor tab attaches.
 */

import { CornerDownLeft, PanelRight } from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { findClaudeInputRegion } from "../lib/claude-input.ts"
import { useAppState } from "../lib/store.ts"
import { ensureEngineTab } from "../lib/tabs.ts"
import { sendPtyText } from "../lib/terminal.ts"
import { formatError, pushToast } from "../lib/toast.ts"
import { ChatSidebarTree } from "./ChatSidebarTree.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { Toasts } from "./Toasts.tsx"
import { TtyBlocksView } from "./TtyBlocksView.tsx"

const ChatTerminal = lazy(() =>
  import("./ChatTerminal.tsx").then((m) => ({ default: m.ChatTerminal })),
)

/** Right rail — a collapsed-by-default file-changes placeholder. The real
 *  Changes pane (diff list) lands here once the core loop is proven; for now
 *  it only shows the uncommitted ± counts so the rail earns its width. */
function ChangesPanel({
  changes,
  onCollapse,
}: {
  changes: { added: number; deleted: number } | undefined
  onCollapse: () => void
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
          Changes
        </span>
        <button
          type="button"
          onClick={onCollapse}
          className="text-[11px] text-subtle hover:text-fg"
          title="Collapse"
          aria-label="Collapse changes panel"
        >
          ⇥
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-3 text-center">
        {changes && (changes.added > 0 || changes.deleted > 0) ? (
          <span className="font-mono text-[13px]">
            <span className="text-kobe-green">+{changes.added}</span>{" "}
            <span className="text-kobe-red">−{changes.deleted}</span>
          </span>
        ) : (
          <span className="font-mono text-[12px] text-subtle">clean</span>
        )}
        <span className="text-[11px] text-subtle">File changes land here.</span>
      </div>
    </aside>
  )
}

/** One translated status line from the engine's own footer (branch | ctx |
 *  quota | mode). Warning lines (⚠) go yellow; the rest stay muted mono. */
function StatusLine({ text }: { text: string }) {
  const warning = text.includes("⚠")
  return (
    <div
      className={`truncate font-mono text-[11px] leading-[1.6] ${
        warning ? "text-kobe-yellow" : "text-subtle"
      }`}
    >
      {text}
    </div>
  )
}

/** The prompt box — pastes into the task's engine PTY (spawn-on-send). */
function Composer({ taskId }: { taskId: string }) {
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
      className="px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
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

/**
 * One live TTY, one render. Every buffer frame splits at Claude Code's
 * input region (lib/claude-input.ts): the BODY re-renders as HTML blocks
 * (lib/claude-tty.ts — boxes → cards, ⏺ prose → dot rows, tool lines →
 * framed results, unrecognized lines verbatim), the input region becomes
 * the GUI composer + translated status lines. The raw xterm stays mounted
 * underneath as the data source and shows through automatically only
 * while a native dialog owns the screen — the one thing HTML can't answer
 * yet (until the PermissionRequest hook wiring lands).
 */
function SessionView({
  tabId,
  taskId,
  needsInput,
}: {
  tabId: string
  taskId: string
  needsInput: boolean
}) {
  const [buffer, setBuffer] = useState("")

  // The body/input split derives from the buffer per render — frames
  // stream at animation rate but React re-renders only on text change.
  const lines = useMemo(() => buffer.split("\n"), [buffer])
  const region = useMemo(() => findClaudeInputRegion(lines), [lines])
  const bodyText = useMemo(
    () => (region ? lines.slice(0, region.topRow).join("\n") : buffer),
    [region, lines, buffer],
  )

  // Raw-terminal takeover: once the composer grammar has been seen, its
  // DISAPPEARANCE means a dialog owns the screen (permission prompt, menu)
  // — flip to the real terminal so the user answers natively, flip back
  // when the prompt returns. Before the first prompt (engine booting) the
  // translated view stays up. needsInput from the daemon is the belt to
  // this suspender.
  const seenRegionRef = useRef(false)
  if (region !== null) seenRegionRef.current = true
  const rawMode =
    needsInput || (seenRegionRef.current && region === null && buffer !== "")

  return (
    <div className="relative h-full">
      {/* The real PTY — always mounted (it IS the data source); visible
          only while a dialog needs native answering. `invisible` (not
          `hidden`) so xterm keeps real dimensions for fit/resize. */}
      <div className={`absolute inset-0 ${rawMode ? "" : "invisible"}`}>
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
            taskId={taskId}
            mode="engine"
            hideComposer
            onBufferChange={setBuffer}
          />
        </Suspense>
      </div>
      {!rawMode && (
        <div className="relative z-10 flex h-full flex-col bg-bg">
          <div className="min-h-0 flex-1">
            <TtyBlocksView bufferText={bodyText} />
          </div>
          <div className="shrink-0 border-t border-line bg-surface">
            <Composer taskId={taskId} />
            {region && region.statusLines.length > 0 && (
              <div className="px-4 pb-2">
                {region.statusLines.map((line) => (
                  <StatusLine key={line} text={line} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function ChatShell() {
  const { tasks, activeTaskId, engineStates, worktreeChanges } = useAppState()
  const [selectedId, setSelectedId] = useState<string | null>(null)

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

  // Same tab id the workspace vendor tab uses — both surfaces share one PTY.
  // ensureEngineTab mutates the tabs store, so resolve it in an effect (not
  // during render).
  const selectedTaskId = selected?.id ?? null
  const [tabId, setTabId] = useState<string | null>(null)
  useEffect(() => {
    setTabId(selectedTaskId ? ensureEngineTab(selectedTaskId) : null)
  }, [selectedTaskId])

  // Right rail: collapsed by default — the sidebar already tells the status
  // story; the rail returns when the file-changes pane earns it.
  const [showChanges, setShowChanges] = useState(false)

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
              <button
                type="button"
                onClick={() => setShowChanges((cur) => !cur)}
                aria-pressed={showChanges}
                className={`ml-auto flex items-center gap-1 rounded-sm border px-2 py-1 text-[11px] transition-colors ${
                  showChanges
                    ? "border-line-active bg-inset text-fg"
                    : "border-line text-subtle hover:text-fg"
                }`}
                title="Toggle the file-changes panel"
              >
                <PanelRight size={12} strokeWidth={2} />
              </button>
            </div>
            <div className="relative min-h-0 flex-1">
              {tabId && (
                <SessionView
                  key={tabId}
                  tabId={tabId}
                  taskId={selected.id}
                  needsInput={needsInput}
                />
              )}
            </div>
          </main>
        ) : (
          <main className="flex flex-1 items-center justify-center text-[12px] text-subtle">
            No sessions — create a task first.
          </main>
        )}

        {selected && showChanges && (
          <ChangesPanel
            changes={
              selected.worktreePath
                ? worktreeChanges[selected.worktreePath]
                : undefined
            }
            onCollapse={() => setShowChanges(false)}
          />
        )}
      </div>
      <Toasts />
    </div>
  )
}
