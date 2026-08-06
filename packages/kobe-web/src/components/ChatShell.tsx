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
  useRef,
  useState,
} from "react"
import { isMenuRow, type TtyBlock } from "../lib/claude-tty.ts"
import { type EngineGrammar, grammarFor } from "../lib/engine-grammar.ts"
import {
  closeSettings,
  selectChatTask,
  setChatSurface,
  useGlobalUiState,
} from "../lib/global-ui.ts"
import { rpc, useAppState } from "../lib/store.ts"
import {
  ensureEngineTab,
  resetTabTitle,
  setTabTitle,
  type TerminalTab,
  useTabsState,
  type VendorTab,
} from "../lib/tabs.ts"
import {
  type ColoredLine,
  sameColoredLine,
  trimLeadingColored,
} from "../lib/tty-color.ts"
import { resolveVendor } from "../lib/vendor.ts"
import { ChatSidebarTree } from "./ChatSidebarTree.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { InputMirror } from "./InputMirror.tsx"
import { PaneResizer, usePaneWidth } from "./PaneResizer.tsx"
import { TimelineHost } from "./TimelineHost.tsx"
import { Toasts } from "./Toasts.tsx"
import { TtyBlocksView, TtyFooter, useTtyBlocks } from "./TtyBlocksView.tsx"

const ChatTerminal = lazy(() =>
  import("./ChatTerminal.tsx").then((m) => ({ default: m.ChatTerminal })),
)
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

/** One status-footer line (branch | ctx | quota | mode), rendered from the
 *  colored buffer so it keeps the engine's own ANSI colors (blue branch,
 *  cyan tok/s, orange diff, red bypass-permissions). Uncolored runs fall to
 *  muted grey. */
function StatusLine({ line }: { line: ColoredLine }) {
  return (
    <div className="truncate font-mono text-[11px] leading-[1.6] text-subtle">
      {line.segs.map((seg, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: colored runs are positional, re-derived per frame
          key={i}
          style={seg.color ? { color: seg.color } : undefined}
        >
          {seg.text}
        </span>
      ))}
    </div>
  )
}

/** A horizontal-rule row (the composer's frame lines) — dropped from status. */
const STATUS_RULE = /^[─━═╌╍-]{3,}\s*$/

/**
 * One shell PTY per tab. The tab owns the parent shell; an engine CLI is a
 * CHILD process inside it. The translated chat UI engages WHENEVER the
 * engine's input region is detected on screen — regardless of tab kind
 * (vendor auto-types the engine command; shell starts bare) — and falls back
 * to the RAW visible terminal when it isn't (bare shell prompt, engine
 * exited, native full-screen dialog). Launching `claude` by hand in a Shell
 * tab gets the full translated UI; an engine exiting drops you back to a
 * usable shell. Clicking anywhere focuses the PTY so keystrokes drive it
 * directly (slash menus, @-complete, arrow selection).
 */
function SessionView({
  tabId,
  taskId,
  sessionId,
  mode,
  vendor,
  grammar,
  onEngineLive,
}: {
  tabId: string
  taskId: string
  sessionId: string | null
  /** Vendor tabs → 'engine' (auto-types the engine command); terminal tabs → 'shell'. */
  mode: "engine" | "shell"
  /** Per-tab engine vendor override (VendorTab.vendor → ChatTerminal). */
  vendor?: string
  /** The vendor's screen grammar (engine-grammar.ts) — drives the translation. */
  grammar: EngineGrammar
  /** Grammar-derived engine liveness, lifted so the Agent Trace can clear
   *  when this tab drops to a bare shell / boot screen. */
  onEngineLive?: (live: boolean) => void
}) {
  const [colored, setColored] = useState<ColoredLine[]>([])
  const [focusNonce, setFocusNonce] = useState(0)
  // Frame stabilizer: reuse previous line OBJECTS for unchanged rows so
  // memoized children skip re-render — a keystroke only re-renders the input
  // row's dependents, not the whole transcript.
  const prevLinesRef = useRef<ColoredLine[]>([])
  const onColoredBuffer = useCallback((next: ColoredLine[]) => {
    const prev = prevLinesRef.current
    let allSame = next.length === prev.length
    const stable = next.map((line, i) => {
      const p = prev[i]
      if (p && sameColoredLine(p, line)) return p
      allSame = false
      return line
    })
    prevLinesRef.current = allSame ? prev : stable
    setColored(prevLinesRef.current)
  }, [])
  // IME composing string (pinyin buffer) from the hidden textarea — the PTY
  // only sees committed text, so the composer must mirror this itself.
  const [composing, setComposing] = useState<string | null>(null)
  // Real terminal cursor (viewport row + cell col) — the mirror's caret
  // follows it instead of pinning to the end of the prompt text.
  const [cursor, setCursor] = useState<{ row: number; col: number } | null>(
    null,
  )

  // Split each frame at the engine's input region: everything above it is the
  // conversation body, the region itself is the current input line + status.
  const textLines = useMemo(() => colored.map((l) => l.text), [colored])
  const region = useMemo(
    () => grammar.findInputRegion(textLines),
    [grammar, textLines],
  )
  // Last exit banner — reverse loop (no findLastIndex typing on ColoredLine[]).
  const lastExitIdx = useMemo(() => {
    const banner = grammar.exitBanner
    if (!banner) return -1
    for (let i = colored.length - 1; i >= 0; i--) {
      const line = colored[i]
      if (line && banner.test(line.text.trim())) return i
    }
    return -1
  }, [grammar, colored])
  // Resume banner below the input box → box is stale; banner above → relaunched, live.
  const engineLive =
    region !== null && !(lastExitIdx >= 0 && lastExitIdx >= region.topRow)
  // Engine child exited (ctrl+c → shell) → restore the minted tab title; a
  // bare shell may never emit an OSC title to overwrite the engine's.
  const wasLiveRef = useRef(false)
  useEffect(() => {
    onEngineLive?.(engineLive)
    if (wasLiveRef.current && !engineLive) resetTabTitle(taskId, tabId)
    wasLiveRef.current = engineLive
  }, [engineLive, taskId, tabId, onEngineLive])
  const bodyLines = useMemo(
    () => (region ? colored.slice(0, region.topRow) : colored),
    [region, colored],
  )
  // Lift the right-aligned `● high · /effort` chip out of the scroll body
  // so it can pin above the composer (matching the CLI's placement).
  const { chatBodyLines, effortLine } = useMemo(() => {
    const pattern = grammar.effortLine
    if (!pattern) return { chatBodyLines: bodyLines, effortLine: null }
    for (let i = bodyLines.length - 1; i >= 0; i--) {
      const line = bodyLines[i]
      if (line && pattern.test(line.text.trim())) {
        return {
          chatBodyLines: [...bodyLines.slice(0, i), ...bodyLines.slice(i + 1)],
          effortLine: line as ColoredLine | null,
        }
      }
    }
    return { chatBodyLines: bodyLines, effortLine: null }
  }, [grammar, bodyLines])
  // Caret CHAR offset from the cursor's CELL column (>0xFF ≈ 2 cells —
  // CJK-good; wcwidth if emoji matters). The region's promptText is trimmed
  // (terminal rows are padded to full width), so TRAILING spaces the user
  // just typed vanish — when the cursor sits past the trimmed end, restore
  // them so the caret keeps moving through space runs.
  const { promptText, caretOffset } = useMemo(() => {
    const trimmed = region?.promptText ?? ""
    if (!region || !cursor || cursor.row !== region.promptRow || !trimmed)
      return { promptText: trimmed, caretOffset: null }
    const raw = colored[region.promptRow]?.text ?? ""
    const start = raw.indexOf(trimmed)
    if (start < 0) return { promptText: trimmed, caretOffset: null }
    const targetCells = cursor.col - start
    if (targetCells < 0) return { promptText: trimmed, caretOffset: null }
    let cells = 0
    let idx = 0
    for (const ch of trimmed) {
      if (cells >= targetCells) break
      cells += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1
      idx += ch.length
    }
    if (targetCells > cells) {
      const pad = targetCells - cells
      return {
        promptText: trimmed + " ".repeat(pad),
        caretOffset: trimmed.length + pad,
      }
    }
    return { promptText: trimmed, caretOffset: Math.min(idx, trimmed.length) }
  }, [region, cursor, colored])
  // Status footer (branch | ctx | quota | mode) as COLORED lines, straight
  // from the buffer below the prompt — so it keeps the engine's ANSI colors
  // instead of flattening to grey. Rule/blank rows dropped.
  // Below-composer tail: true status rows stay in the footer; slash-menu rows
  // (Codex draws its menu BELOW the composer) lift into the floated menu.
  const { statusColored, belowMenu } = useMemo(() => {
    if (!region) return { statusColored: [], belowMenu: [] as TtyBlock[] }
    const below = colored.slice(region.promptRow + 1)
    const menuRows = below.filter((l) => isMenuRow(l.text))
    const menu =
      menuRows.length >= 2
        ? grammar.parseBlocks(menuRows).filter((b) => b.kind === "menu")
        : []
    const status = below.filter((l) => {
      const t = l.text.trim()
      return t !== "" && !STATUS_RULE.test(t) && !isMenuRow(l.text)
    })
    return { statusColored: status, belowMenu: menu }
  }, [region, colored, grammar])
  // The live footer (spinner/tip/slash-menu below the last gap) is lifted out
  // of the scroll body and floated just above the input row — where the native
  // TUI shows it — instead of leaving it adrift in the history.
  const { body: rawBody, footer: rawFooter } = useTtyBlocks(
    chatBodyLines,
    grammar,
  )
  // Claude's `※ recap` docks above the composer instead of drifting in the
  // flow — strip every occurrence, pin the newest.
  const { body, bodyFooter, recap } = useMemo((): {
    body: readonly TtyBlock[]
    bodyFooter: readonly TtyBlock[]
    recap: { kind: "recap"; text: string } | null
  } => {
    let last: { kind: "recap"; text: string } | null = null
    const strip = (arr: readonly TtyBlock[]): readonly TtyBlock[] => {
      if (!arr.some((b) => b.kind === "recap")) return arr
      return arr.filter((b) => {
        if (b.kind === "recap") {
          last = b
          return false
        }
        return true
      })
    }
    const nextBody = strip(rawBody)
    const nextFooter = strip(rawFooter)
    return { body: nextBody, bodyFooter: nextFooter, recap: last }
  }, [rawBody, rawFooter])
  const footer = useMemo(
    () => (belowMenu.length > 0 ? [...bodyFooter, ...belowMenu] : bodyFooter),
    [bodyFooter, belowMenu],
  )
  // A bordered card is only warranted when the engine is WAITING on the user
  // (spinner / slash-menu / question). Passive notices (clipboard hint) get a
  // quiet unboxed line instead.
  const footerInteractive = footer.some(
    (b) => b.kind === "menu" || b.kind === "options" || b.kind === "activity",
  )
  // a. engineLive → translated stack; b. empty buffer → BootLine placeholder;
  // c. otherwise → raw terminal takeover (no overlay, no composer mirror).
  const showTranslated = engineLive || colored.length === 0

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click anywhere focuses the PTY so typing drives the native CLI / shell
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard input already routes to the PTY; the click is only a focus assist
    <div
      className="relative h-full"
      onClick={() => {
        // Click focuses the PTY — but a drag-select stays a selection: don't
        // steal focus (and collapse the range) when text was just selected.
        if (window.getSelection()?.toString()) return
        setFocusNonce((n) => n + 1)
      }}
    >
      {/* Real PTY — data source + input target. opacity-0 while translated so
          its input stays focusable under the overlay; drops opacity when raw
          (bare shell / dialog / engine exited). SAME px-4 as the translated
          column so the native lays out at the width we render. */}
      <div
        className={
          showTranslated
            ? "absolute inset-0 px-4 opacity-0"
            : "absolute inset-0 px-4"
        }
      >
        <Suspense fallback={null}>
          <ChatTerminal
            key={tabId}
            tabId={tabId}
            taskId={taskId}
            mode={mode}
            hideComposer
            focusNonce={focusNonce}
            vendor={vendor}
            onColoredBuffer={onColoredBuffer}
            // Strip the engine's own status glyph (✳/✱) — the row draws its own.
            onTitle={(t) =>
              setTabTitle(
                taskId,
                tabId,
                t.replace(/^[✳✱⏺●○]\s*/, "").slice(0, 60),
              )
            }
            onComposition={setComposing}
            onCursor={setCursor}
          />
        </Suspense>
      </div>
      {showTranslated && (
        <div className="relative z-10 flex h-full flex-col bg-bg">
          <div className="min-h-0 flex-1">
            <TtyBlocksView blocks={body} sessionId={sessionId} />
          </div>
          {/* One composer zone: every row runs edge-to-edge with the input
              card, so the gaps (not indents) do the grouping. */}
          <div className="shrink-0 space-y-1.5 px-4 pb-3 pt-1">
            {footer.length > 0 &&
              (footerInteractive ? (
                // A card only when the engine is WAITING on the user (spinner
                // / slash-menu / question). Passive notices don't earn one.
                <div className="rounded-2xl border border-line bg-surface/50 px-4 py-2.5">
                  <TtyFooter blocks={footer} sessionId={sessionId} />
                </div>
              ) : (
                // Passive hints (Image in clipboard…) — quiet line above input.
                <div className="text-[11px]">
                  <TtyFooter blocks={footer} sessionId={sessionId} />
                </div>
              ))}
            {effortLine && (
              <div className="fade-up flex justify-end">
                <StatusLine line={trimLeadingColored(effortLine)} />
              </div>
            )}
            {recap && (
              <div className="fade-up text-[12px] leading-relaxed text-muted">
                <span className="mr-1.5 select-none text-subtle">※</span>
                {recap.text}
              </div>
            )}
            {/* No composer until the engine draws one — during boot (empty
                buffer / harness setup) the mirror has nothing to mirror. */}
            {engineLive && (
              <InputMirror
                promptText={promptText}
                composing={composing}
                caretOffset={caretOffset}
                sessionId={sessionId}
              />
            )}
            {statusColored.length > 0 && (
              // Dim the whole group instead of the segs — the rows keep the
              // engine's ANSI colors, just quieter.
              <div className="opacity-75">
                {statusColored.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional status rows re-derived per frame
                  <StatusLine key={i} line={line} />
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
  const { tasks, activeTaskId, engineStates, engineTabSessions, attentionInbox } =
    useAppState()
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
  const [sidebarW, dragSidebar] = usePaneWidth("kobe-web.pane.sidebar", 256, 190, 420, 1)
  const [traceW, dragTrace] = usePaneWidth("kobe-web.pane.trace", 320, 240, 640, -1)
  // Active tab's grammar-derived engine liveness (SessionView reports it up).
  // Off → the trace panel clears instead of parading a dead session.
  const [engineLive, setEngineLive] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab switch resets liveness until the new SessionView reports
  useEffect(() => {
    setEngineLive(false)
  }, [tabId])

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
                    (tabId
                      ? engineTabSessions[selected.id]?.[tabId]
                      : undefined) ??
                    engineStates[selected.id]?.sessionId ??
                    null
                  }
                  mode={mode}
                  vendor={vendor}
                  grammar={grammarFor(vendor ?? selected.vendor)}
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
            worktreePath={selected.worktreePath || null}
            vendor={resolveVendor(vendor ?? selected.vendor)}
            engineState={engineStates[selected.id]}
            tabSessionId={
              tabId ? engineTabSessions[selected.id]?.[tabId] : undefined
            }
            engineActive={engineLive}
            width={traceW}
          />
        )}
      </div>
      <Toasts />
    </div>
  )
}
