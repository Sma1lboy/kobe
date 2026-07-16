/** @jsxImportSource @opentui/react */
/**
 * Workspace tab strip — React port of `tui/workspace/tab-strip.tsx` (issue
 * #16 React migration). The row of engine/command tabs above the embedded
 * terminal. Owns the per-tab turn chip and the turn-complete pulse: when a
 * tab's turn flips running→done, the chip and title flash emphasized for a
 * few frames before settling — a landing cue for work that finished while
 * you looked elsewhere. Engines whose visible OSC title already owns the
 * activity state omit the duplicate chip.
 *
 * Naming policy (`tabTitle`, `visibleNativeStatus`) is framework-free and
 * lives with its sibling `splitLeafNames` in `terminal-tab-split.ts`;
 * `tabTitle` is re-exported here for `TerminalTabs.tsx`'s non-render uses
 * (rename dialog prefill, notification titles).
 */

import { TextAttributes } from "@opentui/core"
import { useEffect, useRef, useState } from "react"
import type { ChatTabTurnState } from "../../engine/turn-detector"
import { type TerminalTab, tabTitle, visibleNativeStatus } from "../../tui/workspace/terminal-tabs-core"
import type { VendorId } from "../../types/vendor"
import { useTheme } from "../context/theme"

export { tabTitle }

/** Same glyph vocabulary as tmux's `CHAT_TAB_STATUS_FORMAT` (`@kobe_tab_state`). */
export const TURN_GLYPHS: Record<ChatTabTurnState, string> = {
  running: "●",
  done: "✓",
  error: "!",
  // Hook-only "blocked on the user" state — same ?/warning pairing as the
  // sidebar's permission_needed badge (row-view.ts). No collision with
  // `unknown`: that placeholder is never rendered (skip below).
  needs_input: "?",
  unknown: "?",
  idle: "○",
}

/** How long the running→done pulse stays emphasized. */
const DONE_PULSE_MS = 600

export function TabStrip(props: {
  tabs: readonly TerminalTab[]
  activeId: string
  turnStates: ReadonlyMap<string, ChatTabTurnState>
  onSelect: (tabId: string) => void
  /** Task-level engine — the default-name fallback for unpinned tabs. */
  vendor: VendorId
  /** tabId → live process display name (see `useTurnPolls().liveTitles`). */
  liveTitles: ReadonlyMap<string, string>
  /** tabId → resolved live engine identity (see `useTurnPolls().turnVendors`). */
  turnVendors: ReadonlyMap<string, VendorId>
}) {
  const themeCtx = useTheme()
  const { theme } = themeCtx

  /* --------- turn-complete pulse ---------------------------------------
   * Track running→done transitions; a transitioned tab id sits in
   * `pulsing` for DONE_PULSE_MS then drops out, un-emphasizing the chip.
   * Plain prev-map comparison (a ref, not state) — the effect re-runs
   * only when the turnStates map identity changes (the caller always
   * writes a new Map). */
  const prevTurns = useRef(new Map<string, ChatTabTurnState>())
  const [pulsing, setPulsing] = useState<ReadonlySet<string>>(new Set())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    for (const [tabId, turn] of props.turnStates) {
      const prev = prevTurns.current.get(tabId)
      prevTurns.current.set(tabId, turn)
      if (turn !== "done" || prev !== "running" || themeCtx.reducedMotion) continue
      setPulsing((cur) => new Set(cur).add(tabId))
      const timer = setTimeout(() => {
        timers.current.delete(timer)
        setPulsing((cur) => {
          const next = new Set(cur)
          next.delete(tabId)
          return next
        })
      }, DONE_PULSE_MS)
      timers.current.add(timer)
    }
    for (const id of [...prevTurns.current.keys()]) if (!props.turnStates.has(id)) prevTurns.current.delete(id)
  }, [props.turnStates, themeCtx.reducedMotion])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
    }
  }, [])

  return (
    <box flexDirection="row" gap={1} flexShrink={0} paddingLeft={1} backgroundColor={theme.backgroundElement}>
      {props.tabs.map((tab) => {
        const turn = props.turnStates.get(tab.id) ?? "idle"
        const liveTitle = props.liveTitles.get(tab.id)
        const nativeStatusVisible = visibleNativeStatus(tab, props.vendor, props.turnVendors.get(tab.id), liveTitle)
        const pulse = pulsing.has(tab.id)
        const turnColor =
          turn === "running"
            ? theme.focusAccent
            : turn === "done"
              ? theme.success
              : turn === "error"
                ? theme.error
                : turn === "needs_input"
                  ? theme.warning
                  : theme.textMuted
        return (
          <box key={tab.id} flexDirection="row" gap={0} onMouseUp={() => props.onSelect(tab.id)}>
            {/* Turn chip — tmux CHAT_TAB_STATUS_FORMAT's ●/✓/!/?/○. Shown
                only once the turn detector has an actionable reading for the
                tab. We deliberately skip absent and "unknown" readings: both
                are placeholders with no information, so let the real state
                (or the engine's native title) speak. Hidden while an
                engine-owned live title is visibly carrying the same status. */}
            {!nativeStatusVisible && turn !== "unknown" && props.turnStates.has(tab.id) ? (
              <text fg={turnColor} attributes={pulse ? TextAttributes.BOLD : undefined} wrapMode="none">
                {`${TURN_GLYPHS[turn]} `}
              </text>
            ) : null}
            <text
              fg={pulse ? theme.success : tab.id === props.activeId ? theme.focusAccent : theme.textMuted}
              attributes={pulse || tab.id === props.activeId ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              {tabTitle(tab, props.vendor, liveTitle)}
            </text>
          </box>
        )
      })}
    </box>
  )
}
