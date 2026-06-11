/**
 * ChatTerminal — a live xterm.js attached (over the PTY WebSocket) to one
 * PTY-backed workspace tab. Vendor tabs run the selected engine; terminal
 * tabs run the user's shell. Keyed by tab id in the parent so switching tabs
 * swaps terminals while the PTY persists server-side across reconnects.
 */

import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { useEffect, useRef } from "react"
import { type PtyMode, ptyUrl } from "../lib/terminal.ts"

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
  '"Kobe Nerd Font", "JetBrainsMono Nerd Font", "MesloLGS NF", "Symbols Nerd Font Mono", "SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace'

async function loadTerminalFont(): Promise<void> {
  if (!("fonts" in document)) return
  try {
    await document.fonts.load(`12px "Kobe Nerd Font"`)
  } catch {
    /* fallback font stack still renders if the bundled font fails */
  }
}

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

  useEffect(() => {
    let disposed = false
    const el = ref.current
    if (!el) return

    let term: Terminal | null = null
    let ws: WebSocket | null = null
    let resizeObserver: ResizeObserver | null = null

    void (async () => {
      await loadTerminalFont()
      if (disposed) return

      term = new Terminal({
        theme: CLAUDE_XTERM_THEME,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: 12,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(el)
      try {
        fit.fit()
      } catch {
        /* container not measured yet */
      }

      ws = new WebSocket(ptyUrl(tabId, taskId, mode, term.cols, term.rows))
      ws.binaryType = "arraybuffer"
      ws.onmessage = (e) => {
        const data =
          typeof e.data === "string"
            ? e.data
            : PTY_DECODER.decode(e.data as ArrayBuffer)
        term?.write(data)
      }
      ws.onclose = (event) => {
        if (!disposed) {
          const reason = event.reason ? `: ${event.reason}` : ""
          term?.writeln(`\r\n[detached${reason}]`)
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
    }
  }, [tabId, taskId, mode])

  return <div ref={ref} className="h-full w-full overflow-hidden" />
}
