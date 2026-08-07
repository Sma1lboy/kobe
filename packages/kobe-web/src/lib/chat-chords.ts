/**
 * The /chat shell's keyboard chords — the TUI's vocabulary mirrored onto the
 * windowed surface (same muscle memory, no new placements):
 *
 *   ctrl+a            arm the prefix (1000ms window, HUD chip shows it)
 *   prefix, 1 / 2     rail pages in rail order (Kanban / Routines)
 *   mod+2…9,0         jump to the sidebar row printing that digit
 *   mod+t             new tab, same engine (TUI chat.tab.new)
 *   mod+e             new tab, choose engine (TUI chat.tab.chooseEngine)
 *   mod+w             close tab
 *
 * `mod` is ⌘ in the desktop app (ctrl stays free for the terminal) and
 * ctrl in the browser build; the ctrl+a prefix is universal.
 *   j / k / enter     tree cursor + activate (only outside inputs/terminal)
 *   [ / ]             Active ⇄ Archives view
 *   /                 focus the sidebar search
 *
 * Listener runs on window CAPTURE so modifier chords win over the embedded
 * xterm (the same reservation the TUI makes — ctrl+a never reaches the
 * engine). Bare letters are gated on "not typing": xterm's helper textarea
 * counts as typing, so j/k in the terminal still reach the engine.
 */

import { useEffect, useRef, useState } from "react"
import { isDesktopMode } from "./desktop.ts"

/** Mirror of the TUI's TASK_JUMP_DIGITS (jump-digits.ts): row 0 prints and
 *  answers to `2` — ctrl+1 has no terminal encoding, and the web keeps the
 *  same printed digits so the muscle memory transfers verbatim. */
export const TASK_JUMP_DIGITS: readonly string[] = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "0",
]

/** The digit shown on (and jumping to) a row, or null past the ninth. */
export function taskJumpDigit(rowIndex: number): string | null {
  return TASK_JUMP_DIGITS[rowIndex] ?? null
}

const PREFIX_TIMEOUT_MS = 1000

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable
  )
}

export interface ChatChordHandlers {
  /** Activate the sidebar row at flat index (ctrl+digit jump). */
  onJumpRow: (flatIndex: number) => void
  /** Move the tree cursor (j/k). */
  onCursorMove: (delta: 1 | -1) => void
  /** Activate the cursor row (enter). */
  onCursorActivate: () => void
  /** Cycle the Active/Archives view ([ / ]). */
  onCycleView: (delta: 1 | -1) => void
  /** Focus the sidebar search input (/). */
  onFocusSearch: () => void
  /** Open the Nth rail page (prefix, digit — 0 = Kanban, 1 = Routines). */
  onRailPage: (index: number) => void
  /** Open the attention Inbox (prefix, i — the TUI's chord). */
  onOpenInbox: () => void
  /** New engine tab inheriting the task's engine (ctrl+t — TUI chat.tab.new). */
  onNewTab: () => void
  /** New engine tab via engine picker (ctrl+e — TUI chat.tab.chooseEngine). */
  onChooseEngine: () => void
  /** Close the active tab (ctrl+w — TUI chat.tab.close). */
  onCloseTab: () => void
}

/** Install the chord listener; returns whether the prefix is armed (HUD). */
export function useChatChords(handlers: ChatChordHandlers): boolean {
  const [armed, setArmed] = useState(false)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    const disarm = (): void => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setArmed(false)
    }

    const onKey = (event: KeyboardEvent): void => {
      const h = handlersRef.current
      // Second stroke: the armed prefix consumes the NEXT keydown wholesale
      // (same as the TUI HUD) — valid strokes act, anything else cancels.
      if (timerRef.current !== null) {
        // Modifier keydowns themselves (shift/ctrl going down) are not
        // strokes — let the real key arrive.
        if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        disarm()
        if (event.key === "1") h.onRailPage(0)
        else if (event.key === "2") h.onRailPage(1)
        else if (event.key === "i") h.onOpenInbox()
        // escape / unknown stroke: already disarmed, swallow silently.
        return
      }

      // Desktop (mac) speaks ⌘ for app chords, freeing ctrl for the
      // terminal underneath; the browser build keeps the TUI's ctrl. The
      // PREFIX stays ctrl+a everywhere — ⌘a is select-all and sacred.
      const meta = isDesktopMode()
      const ctrl = event.ctrlKey && !event.metaKey && !event.altKey
      const chord = meta
        ? event.metaKey && !event.ctrlKey && !event.altKey
        : ctrl
      if (ctrl && event.key.toLowerCase() === "a") {
        event.preventDefault()
        event.stopPropagation()
        setArmed(true)
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          setArmed(false)
        }, PREFIX_TIMEOUT_MS)
        return
      }
      // chord+<digit> task jump — global tier, works from inside the terminal.
      if (chord) {
        const key = event.key.toLowerCase()
        if (key === "t") {
          event.preventDefault()
          event.stopPropagation()
          h.onNewTab()
          return
        }
        if (key === "e") {
          event.preventDefault()
          event.stopPropagation()
          h.onChooseEngine()
          return
        }
        if (key === "w") {
          event.preventDefault()
          event.stopPropagation()
          h.onCloseTab()
          return
        }
        const slot = TASK_JUMP_DIGITS.indexOf(event.key)
        if (slot >= 0) {
          event.preventDefault()
          event.stopPropagation()
          h.onJumpRow(slot)
        }
        return
      }
      // Bare keys: never while typing (inputs, composer, xterm textarea).
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target)
      )
        return
      if (event.key === "j") {
        event.preventDefault()
        h.onCursorMove(1)
      } else if (event.key === "k") {
        event.preventDefault()
        h.onCursorMove(-1)
      } else if (event.key === "Enter") {
        event.preventDefault()
        h.onCursorActivate()
      } else if (event.key === "[") {
        event.preventDefault()
        h.onCycleView(-1)
      } else if (event.key === "]") {
        event.preventDefault()
        h.onCycleView(1)
      } else if (event.key === "/") {
        event.preventDefault()
        h.onFocusSearch()
      }
    }

    window.addEventListener("keydown", onKey, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true })
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  return armed
}
