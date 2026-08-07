/**
 * ChatShell — kobe as a windowed TERMINAL app (/chat, hosted by the
 * kobe-desktop Electron shell). Every tab is a shell PTY; an engine CLI is a
 * CHILD process inside it. When the engine's input region is on screen, what
 * you SEE is that screen translated to HTML (TtyBlocksView over
 * lib/claude-tty.ts) with the GUI composer standing in for the native input
 * row. Otherwise the raw xterm takes the pixels (bare shell, engine exited,
 * native full-screen dialog). No view toggle, no second transcript.
 *
 * Left rail mirrors the TUI tree sidebar; right is a collapsed-by-default
 * Changes placeholder. One PTY per task tab — the same one the workspace
 * vendor tab attaches.
 */

import { PanelRight } from "lucide-react"
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import { grammarFor } from "../lib/engine-grammar.ts"
import { useEngines } from "../lib/engines.ts"
import {
  closeSettings,
  selectChatTask,
  setChatSurface,
  useGlobalUiState,
} from "../lib/global-ui.ts"
import { rpc, useAppState } from "../lib/store.ts"
import {
  ensureEngineTab,
  type TerminalTab,
  useTabsState,
  type VendorTab,
} from "../lib/tabs.ts"
import { fetchPtyForeground, sendPtyText } from "../lib/terminal.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import {
  type PendingTraceQuote,
  serializePendingTraceQuotes,
} from "../lib/trace-content.ts"
import { resolveVendor } from "../lib/vendor.ts"
import { ChatSidebarTree } from "./ChatSidebarTree.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { PaneResizer, usePaneWidth } from "./PaneResizer.tsx"
import { SessionView } from "./SessionView.tsx"
import { TimelineHost } from "./TimelineHost.tsx"

// Kanban / Routines render INSIDE the /chat main area (a surface switch, not
// a route jump) — lazy so the chat-first load doesn't pay for them.
const Board = lazy(() =>
  import("./Board.tsx").then((m) => ({ default: m.Board })),
)
const RoutinesPage = lazy(() =>
  import("./RoutinesPage.tsx").then((m) => ({ default: m.RoutinesPage })),
)
const SettingsPage = lazy(() =>
  import("./SettingsPage.tsx").then((m) => ({ default: m.SettingsPage })),
)

export function ChatShell() {
  const {
    tasks,
    activeTaskId,
    engineStates,
    engineTabSessions,
    sessionBindings,
    sessionTransitions,
    attentionInbox,
  } = useAppState()
  const { tabsByTask, activeByTask } = useTabsState()
  // Surface + selection live in the global-ui store so the root-level command
  // palette can drive the shell (jump task / open Kanban / open Routines).
  const {
    chatSurface: surface,
    chatSelectedTaskId: selectedId,
    settingsOpen,
  } = useGlobalUiState()

  const live = useMemo(() => tasks.filter((t) => !t.archived), [tasks])
  const selected =
    live.find((t) => t.id === selectedId) ??
    live.find((t) => t.id === activeTaskId) ??
    live[0] ??
    null

  // Prefer the task's ACTIVE vendor or terminal tab; fall back to
  // ensureEngineTab only when neither is active — never mutate during render.
  const selectedTaskId = selected?.id ?? null
  const { vendorTab, terminalTab } = useMemo((): {
    vendorTab: VendorTab | null
    terminalTab: TerminalTab | null
  } => {
    if (!selectedTaskId) return { vendorTab: null, terminalTab: null }
    const activeId = activeByTask[selectedTaskId]
    const list = tabsByTask[selectedTaskId] ?? []
    const tab = activeId ? list.find((t) => t.id === activeId) : undefined
    if (tab && tab.kind === "vendor" && !tab.taskId)
      return { vendorTab: tab, terminalTab: null }
    if (tab && tab.kind === "terminal")
      return { vendorTab: null, terminalTab: tab }
    return { vendorTab: null, terminalTab: null }
  }, [selectedTaskId, tabsByTask, activeByTask])

  const [fallbackTabId, setFallbackTabId] = useState<string | null>(null)
  useEffect(() => {
    if (!selectedTaskId || vendorTab || terminalTab) {
      setFallbackTabId(null)
      return
    }
    setFallbackTabId(ensureEngineTab(selectedTaskId))
  }, [selectedTaskId, vendorTab, terminalTab])

  // Both vendor and terminal tabs go through SessionView; only the PTY mode
  // differs (vendor/fallback → engine auto-type; terminal → bare shell).
  const tabId = vendorTab?.id ?? terminalTab?.id ?? fallbackTabId
  const mode: "engine" | "shell" = terminalTab ? "shell" : "engine"
  const vendor = vendorTab?.vendor

  // Which engine ACTUALLY runs in this tab (sidecar process walk). Tab
  // metadata is a spawn-time hint that old tabs and quick-created tabs may
  // lack — trusting it alone picked the wrong screen grammar intermittently
  // (claude's 8-row tail window on a codex screen → raw takeover the moment
  // its below-composer menu opened). The child process is the truth.
  const engines = useEngines()
  const [fgVendor, setFgVendor] = useState<string | null>(null)
  useEffect(() => {
    if (!tabId) {
      setFgVendor(null)
      return
    }
    let cancelled = false
    const poll = (): void => {
      void fetchPtyForeground().then((map) => {
        if (cancelled) return
        const comms = map[tabId] ?? []
        const hit = engines.find((e) => comms.includes(e.id))
        setFgVendor(hit ? hit.id : null)
      })
    }
    poll()
    const timer = window.setInterval(poll, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [tabId, engines])
  const effectiveVendor = fgVendor ?? vendor ?? selected?.vendor

  // Visit resolves the episode — same contract as the TUI (and the Inbox's
  // click-through): an attention item for the tab you are LOOKING AT is
  // already read, so it never demands a second acknowledgement.
  const selectedIdForAttention = selected?.id ?? null
  useEffect(() => {
    if (!selectedIdForAttention || !tabId || settingsOpen || surface !== "chat")
      return
    if (document.hidden) return
    for (const item of attentionInbox) {
      if (item.taskId !== selectedIdForAttention || item.tabId !== tabId)
        continue
      void rpc("attention.dismiss", {
        taskId: item.taskId,
        tabId: item.tabId ?? undefined,
        at: item.at,
      }).catch(() => {})
    }
  }, [attentionInbox, selectedIdForAttention, tabId, settingsOpen, surface])

  // Agent Trace is the GUI-native execution inspector. It starts open so
  // the two-level thought/tool model is visible without introducing a chord.
  const [showTimeline, setShowTimeline] = useState(true)
  // Drag-resizable flanks: task sidebar (divider on its right) and Agent
  // Trace (divider on its left). Widths persist per browser.
  const [sidebarW, dragSidebar] = usePaneWidth(
    "kobe-web.pane.sidebar",
    256,
    190,
    420,
    1,
  )
  const [traceW, dragTrace] = usePaneWidth(
    "kobe-web.pane.trace",
    320,
    240,
    640,
    -1,
  )
  // Active tab's grammar-derived engine liveness (SessionView reports it up).
  // It decorates live status only; the durable binding keeps history visible.
  const [engineLive, setEngineLive] = useState(false)
  const [quoteFocusRequest, setQuoteFocusRequest] = useState(0)
  const [quoteBuffers, setQuoteBuffers] = useState<
    Record<string, readonly PendingTraceQuote[]>
  >({})
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab switch resets liveness until the new SessionView reports
  useEffect(() => {
    setEngineLive(false)
  }, [tabId])

  const activeBinding =
    selected && tabId ? sessionBindings[selected.id]?.[tabId] : undefined
  const activeTransition =
    selected && tabId ? sessionTransitions[selected.id]?.[tabId] : undefined
  const legacySessionId =
    selected && tabId ? engineTabSessions[selected.id]?.[tabId] : undefined
  const pendingQuotes = tabId ? (quoteBuffers[tabId] ?? []) : []
  const quoteToBuffer = useCallback(
    async (quote: PendingTraceQuote): Promise<void> => {
      if (!tabId) throw new Error("no active chat tab")
      setQuoteBuffers((current) => {
        const buffered = current[tabId] ?? []
        if (buffered.some((item) => item.sourceId === quote.sourceId))
          return current
        return { ...current, [tabId]: [...buffered, quote] }
      })
      setQuoteFocusRequest((value) => value + 1)
      pushToast("success", "Quote added to the next prompt")
    },
    [tabId],
  )
  const removeBufferedQuote = useCallback(
    (sourceId: string): void => {
      if (!tabId) return
      setQuoteBuffers((current) => ({
        ...current,
        [tabId]: (current[tabId] ?? []).filter(
          (quote) => quote.sourceId !== sourceId,
        ),
      }))
    },
    [tabId],
  )
  const submitBufferedQuotes = useCallback(async (): Promise<void> => {
    if (!tabId || !selectedTaskId) throw new Error("no active chat tab")
    const buffered = quoteBuffers[tabId] ?? []
    if (buffered.length === 0) return
    const submittedIds = new Set(buffered.map((quote) => quote.sourceId))
    try {
      await sendPtyText(
        tabId,
        selectedTaskId,
        serializePendingTraceQuotes(buffered),
      )
      setQuoteBuffers((current) => ({
        ...current,
        [tabId]: (current[tabId] ?? []).filter(
          (quote) => !submittedIds.has(quote.sourceId),
        ),
      }))
    } catch (err) {
      reportError("submit quoted blocks", err)
      throw err
    }
  }, [quoteBuffers, selectedTaskId, tabId])

  return (
    <div className="flex h-full flex-col bg-bg">
      <DaemonBanner />
      <div className="flex min-h-0 flex-1">
        <ChatSidebarTree
          selectedId={selected?.id ?? null}
          onSelect={selectChatTask}
          surface={surface}
          onSurfaceChange={setChatSurface}
          width={sidebarW}
        />
        <PaneResizer onPointerDown={dragSidebar} label="Resize sidebar" />

        {settingsOpen ? (
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <Suspense fallback={null}>
              <SettingsPage onClose={closeSettings} />
            </Suspense>
          </main>
        ) : surface !== "chat" ? (
          <main className="min-w-0 flex-1 overflow-hidden">
            <Suspense fallback={null}>
              {surface === "board" ? (
                <Board
                  initialRepo={selected?.repo}
                  onOpenTask={selectChatTask}
                />
              ) : (
                <RoutinesPage embedded initialRepo={selected?.repo} />
              )}
            </Suspense>
          </main>
        ) : selected ? (
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
              <span className="min-w-0 truncate text-[13px] text-fg">
                {selected.title || selected.branch}
              </span>
              <button
                type="button"
                onClick={() => setShowTimeline((cur) => !cur)}
                aria-pressed={showTimeline}
                className={`ml-auto flex items-center gap-1 rounded-sm border px-2 py-1 text-[11px] transition-colors ${
                  showTimeline
                    ? "border-line-active bg-inset text-fg"
                    : "border-line text-subtle hover:text-fg"
                }`}
                title="Toggle agent trace"
                aria-label="Toggle agent trace"
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
                  sessionId={
                    activeBinding?.sessionId ?? legacySessionId ?? null
                  }
                  mode={mode}
                  vendor={vendor}
                  grammar={grammarFor(effectiveVendor ?? selected.vendor)}
                  focusRequest={quoteFocusRequest}
                  pendingQuotes={pendingQuotes}
                  onRemovePendingQuote={removeBufferedQuote}
                  onSubmitPendingQuotes={submitBufferedQuotes}
                  onEngineLive={setEngineLive}
                />
              )}
            </div>
          </main>
        ) : (
          <main className="flex flex-1 items-center justify-center text-[12px] text-subtle">
            No sessions — create a task first.
          </main>
        )}

        {surface === "chat" && selected && showTimeline && (
          <PaneResizer onPointerDown={dragTrace} label="Resize agent trace" />
        )}
        {surface === "chat" && selected && showTimeline && (
          <TimelineHost
            taskId={selected.id}
            vendor={resolveVendor(effectiveVendor ?? selected.vendor)}
            engineState={engineStates[selected.id]}
            binding={activeBinding}
            transition={activeTransition}
            legacySessionId={legacySessionId}
            engineActive={engineLive}
            width={traceW}
            onQuote={quoteToBuffer}
          />
        )}
      </div>
    </div>
  )
}
