/**
 * The /chat shell's keyboard chords — the TUI's vocabulary mirrored onto the
 * windowed surface (same muscle memory, no new placements):
 *
 *   ctrl+a            arm the prefix (1000ms window, HUD chip shows it)
 *   prefix, 1 / 2     rail pages in rail order (Kanban / Routines)
 *   ctrl+2…9,0        jump to the sidebar row printing that digit
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

      const ctrl = event.ctrlKey && !event.metaKey && !event.altKey
      // ctrl+a arms the prefix — reserved away from the terminal, exactly
      // like the TUI (the engine never sees the prefix byte).
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
      // ctrl+<digit> task jump — global tier, works from inside the terminal.
      if (ctrl) {
        const slot = TASK_JUMP_DIGITS.indexOf(event.key)
        if (slot >= 0) {
          event.preventDefault()
          event.stopPropagation()
          h.onJumpRow(slot)
        }
        return
      }
      // Bare keys: never while typing (inputs, composer, xterm textarea).
      if (event.metaKey || event.altKey || isTypingTarget(event.target)) return
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
