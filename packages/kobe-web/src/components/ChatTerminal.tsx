/**
 * ChatTerminal — a live xterm.js attached (over the PTY WebSocket) to one
 * PTY-backed workspace tab. Vendor tabs run the selected engine; terminal
 * tabs run the user's shell. Keyed by tab id in the parent so switching tabs
 * swaps terminals while the PTY persists server-side across reconnects.
 *
 * Engine tabs get a prompt composer under the terminal: a textarea whose
 * submit pastes into the engine via bracketed paste + Enter (the same
 * delivery contract as kobe's tmux `pasteAndSubmit`), so driving a session
 * doesn't require terminal typing ergonomics. A dropped socket shows a
 * Reattach affordance — the PTY survives server-side and replays its
 * scrollback ring on re-attach, so reattaching is loss-free.
 */

import { ClipboardAddon } from "@xterm/addon-clipboard"
import { FitAddon } from "@xterm/addon-fit"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { WebglAddon } from "@xterm/addon-webgl"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { CornerDownLeft, RotateCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  loadHistory,
  navigateHistory,
  pushHistory,
} from "../lib/composer-history.ts"
import { useAppState } from "../lib/store.ts"
import { consumePendingPrompt } from "../lib/tabs.ts"
import { type PtyMode, ptyUrl } from "../lib/terminal.ts"
import { xtermTheme } from "../lib/theme.ts"
import { isWebTransportOffline } from "../lib/web-transport.ts"

// One decoder reused across every WebSocket message — a fresh `new
// TextDecoder()` per frame (hundreds/sec during engine streaming) was needless
// allocation churn. Stateless here: each binary frame is a self-contained UTF-8
// chunk, decoded in one `decode()` call with no streaming state carried over.
const PTY_DECODER = new TextDecoder()

// xterm palette mirrored from the claude TUI theme (claude.json).
const CLAUDE_XTERM_THEME = {
  background: "#141413",
  foreground: "#eae7df",
  cursor: "#cc785c",
  cursorAccent: "#141413",
  selectionBackground: "#33312e",
  black: "#141413",
  red: "#d47563",
  green: "#9aca86",
  yellow: "#e8c96b",
  blue: "#61aaf2",
  magenta: "#9b87f5",
  cyan: "#d4967e",
  white: "#a9a39a",
  brightBlack: "#6b665f",
  brightRed: "#d47563",
  brightGreen: "#9aca86",
  brightYellow: "#e8c96b",
  brightBlue: "#61aaf2",
  brightMagenta: "#9b87f5",
  brightCyan: "#e0ab96",
  brightWhite: "#eae7df",
} as const

const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "JetBrainsMono Nerd Font", "MesloLGS NF", "Symbols Nerd Font Mono", "SF Mono", ui-monospace, Menlo, monospace'

async function loadTerminalFont(): Promise<void> {
  if (!("fonts" in document)) return
  try {
    await document.fonts.load(`12px "JetBrains Mono"`)
  } catch {
    /* fallback font stack still renders if the bundled font fails */
  }
}

type WsStatus = "connecting" | "open" | "closed"

export function ChatTerminal({
  tabId,
  taskId,
  mode,
}: {
  tabId: string
  taskId: string
  mode: PtyMode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<WsStatus>("connecting")
  // A dropped PTY socket normally means "still running, just detached". But if
  // the daemon web transport is down, the PTY may be PAUSED — the reassuring
  // "keeps running" copy would be wrong. Distinguish the two for the close UI.
  const { daemonConnected, streamConnected } = useAppState()
  const transportOffline = isWebTransportOffline({
    daemonConnected,
    streamConnected,
  })
  // Bumping the epoch tears the terminal down and re-attaches to the
  // SAME server-side PTY (keyed by tab id) — its scrollback ring replays.
  const [epoch, setEpoch] = useState(0)
  // Seed the composer with a task's pending first prompt (set by the New Task
  // dialog) on the first engine tab to mount — consumed once.
  const [draft, setDraft] = useState(() =>
    mode === "engine" ? (consumePendingPrompt(taskId) ?? "") : "",
  )
  // Shell-like prompt recall: ↑/↓ walk previously-sent prompts (newest-first).
  const [history, setHistory] = useState<string[]>(() =>
    mode === "engine" ? loadHistory(taskId) : [],
  )
  const histCursorRef = useRef(-1)
  const liveDraftRef = useRef("")

  // biome-ignore lint/correctness/useExhaustiveDependencies: `epoch` is a deliberate trigger — bumping it tears down + re-attaches to the same server-side PTY (Reattach). It isn't read in the body, so biome thinks it's extraneous, but removing it would break reattach.
  useEffect(() => {
    let disposed = false
    const el = ref.current
    if (!el) return

    let term: Terminal | null = null
    let ws: WebSocket | null = null
    let resizeObserver: ResizeObserver | null = null
    setStatus("connecting")

    void (async () => {
      await loadTerminalFont()
      if (disposed) return

      term = new Terminal({
        // Active TUI-synced palette when loaded; static claude otherwise.
        theme: xtermTheme() ?? CLAUDE_XTERM_THEME,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: 12,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      // Unicode 11 widths: default Unicode 6 measures emoji as one cell,
      // desyncing wrap/cursor from what the server-side PTY apps assume.
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = "11"
      // OSC 52 → navigator.clipboard, so in-terminal copy (tmux/engine
      // copy chords) lands on the viewer's clipboard across the web gap.
      term.loadAddon(new ClipboardAddon())
      // Plain URLs in engine output become clickable.
      term.loadAddon(new WebLinksAddon())
      term.open(el)
      // WebGL renderer when the GPU cooperates; throwing or losing the
      // context falls back to the stock DOM renderer transparently.
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {
        /* DOM renderer fallback */
      }
      try {
        fit.fit()
      } catch {
        /* container not measured yet */
      }

      ws = new WebSocket(ptyUrl(tabId, taskId, mode, term.cols, term.rows))
      wsRef.current = ws
      ws.binaryType = "arraybuffer"
      ws.onopen = () => {
        if (!disposed) setStatus("open")
      }
      ws.onmessage = (e) => {
        // A WS close is async, so a frame already queued can fire after
        // cleanup disposed the terminal — writing to a disposed xterm throws.
        // onopen/onclose already guard on `disposed`; onmessage must too.
        if (disposed) return
        const data =
          typeof e.data === "string"
            ? e.data
            : PTY_DECODER.decode(e.data as ArrayBuffer)
        term?.write(data)
      }
      ws.onclose = (event) => {
        if (!disposed) {
          const reason = event.reason ? `: ${event.reason}` : ""
          term?.writeln(`\r\n[detached${reason} — reattach below]`)
          setStatus("closed")
        }
      }
      term.onData((d) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(d)
      })

      const sendResize = (): void => {
        if (!term) return
        try {
          fit.fit()
        } catch {
          return
        }
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          )
        }
      }
      resizeObserver = new ResizeObserver(() => sendResize())
      resizeObserver.observe(el)
    })()

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      ws?.close()
      term?.dispose()
      wsRef.current = null
    }
  }, [tabId, taskId, mode, epoch])

  const sendPrompt = (): void => {
    const ws = wsRef.current
    const text = draft.trim()
    if (!text || ws?.readyState !== WebSocket.OPEN) return
    // Bracketed paste + Enter — the same submit contract as kobe's tmux
    // prompt delivery (`paste-buffer -p` + Enter), so multi-line prompts
    // arrive as ONE paste instead of line-by-line keystrokes.
    ws.send(`\x1b[200~${text}\x1b[201~`)
    // Defer the Enter so it lands as a SEPARATE tty read. Sent back-to-back the
    // paste and the CR coalesce into one chunk and the engine treats the CR as
    // paste *content* — the prompt sits in the composer, unsent. This mirrors
    // the ~150ms split the sidecar's /pty/send path already uses for the same
    // reason. Re-read wsRef at fire time so a reconnect mid-defer still targets
    // the live socket (same tab → same PTY), and skip if it's gone.
    setTimeout(() => {
      const live = wsRef.current
      if (live?.readyState === WebSocket.OPEN) live.send("\r")
    }, 150)
    setHistory(pushHistory(taskId, text))
    histCursorRef.current = -1
    liveDraftRef.current = ""
    setDraft("")
  }

  const composer = mode === "engine"

  return (
    <div className="flex h-full w-full flex-col">
      <div ref={ref} className="min-h-0 w-full flex-1 overflow-hidden" />
      {status === "closed" ? (
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-t border-line bg-surface px-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-kobe-yellow">
            {transportOffline
              ? "Lost connection to the daemon web transport — the session may be paused. Reattach will retry once it's back."
              : "detached — the session keeps running"}
          </span>
          <button
            type="button"
            onClick={() => setEpoch((cur) => cur + 1)}
            className="flex shrink-0 items-center gap-1.5 border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
          >
            <RotateCw size={11} strokeWidth={2} />
            Reattach
          </button>
        </div>
      ) : composer ? (
        <form
          className="flex shrink-0 items-end gap-2 border-t border-line bg-surface px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            sendPrompt()
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              // Editing means we're back on a live draft, not browsing history.
              histCursorRef.current = -1
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                sendPrompt()
                return
              }
              // Escape exits history browsing → restore the in-progress draft.
              if (event.key === "Escape" && histCursorRef.current >= 0) {
                event.preventDefault()
                histCursorRef.current = -1
                setDraft(liveDraftRef.current)
                return
              }
              const ta = event.currentTarget
              const browsing = histCursorRef.current >= 0
              const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0
              const atEnd =
                ta.selectionStart === draft.length &&
                ta.selectionEnd === draft.length
              // Enter history from a live draft only when the caret is at the
              // edge (so ↑/↓ still move inside a multi-line draft); once
              // browsing, ↑/↓ keep walking the ring regardless of caret.
              if (event.key === "ArrowUp" && (browsing || atStart)) {
                if (histCursorRef.current === -1) liveDraftRef.current = draft
                const step = navigateHistory(
                  history,
                  histCursorRef.current,
                  "up",
                  liveDraftRef.current,
                )
                if (step) {
                  event.preventDefault()
                  histCursorRef.current = step.cursor
                  setDraft(step.value)
                }
              } else if (event.key === "ArrowDown" && (browsing || atEnd)) {
                const step = navigateHistory(
                  history,
                  histCursorRef.current,
                  "down",
                  liveDraftRef.current,
                )
                if (step) {
                  event.preventDefault()
                  histCursorRef.current = step.cursor
                  setDraft(step.value)
                }
              }
            }}
            placeholder="Send a prompt — Enter sends, Shift+Enter newline, ↑ history"
            rows={Math.min(4, Math.max(1, draft.split("\n").length))}
            className="min-w-0 flex-1 resize-none border border-line bg-bg px-2 py-1 text-[12px] leading-relaxed text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim() || status !== "open"}
            className="flex shrink-0 items-center gap-1.5 border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg disabled:opacity-40"
            title="Paste into the engine and submit"
          >
            <CornerDownLeft size={11} strokeWidth={2} />
            Send
          </button>
        </form>
      ) : null}
    </div>
  )
}
