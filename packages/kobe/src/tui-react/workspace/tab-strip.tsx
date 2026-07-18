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

import { type BoxRenderable, TextAttributes } from "@opentui/core"
import { useEffect, useRef, useState } from "react"
import type { ChatTabTurnState } from "../../engine/turn-detector"
import { displayWidth } from "../../lib/display-width"
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

  /* --------- horizontal overflow window --------------------------------
   * With enough tabs the row outgrows the pane and, unclipped, overdraws
   * the pane's right border glyph. The strip is therefore a one-row
   * viewport: the inner row keeps its natural width, the outer box clips
   * (`overflow="hidden"`), and a cell offset (negative marginLeft) scrolls
   * only as far as needed to keep the ACTIVE tab fully visible — a smooth
   * per-cell scroll, not per-tab paging. Widths are computed with the
   * shared display-width table so CJK titles count 2 cells. */
  const entries = props.tabs.map((tab) => {
    const turn = props.turnStates.get(tab.id) ?? "idle"
    const liveTitle = props.liveTitles.get(tab.id)
    const nativeStatusVisible = visibleNativeStatus(tab, props.vendor, props.turnVendors.get(tab.id), liveTitle)
    const chipShown = !nativeStatusVisible && turn !== "unknown" && props.turnStates.has(tab.id)
    const title = tabTitle(tab, props.vendor, liveTitle)
    return { tab, turn, chipShown, title, cells: (chipShown ? 2 : 0) + displayWidth(title) }
  })
  const stripRef = useRef<BoxRenderable | null>(null)
  // Viewport cells (strip width minus the 1-cell left padding); 0 until
  // the first Yoga layout reports a size.
  const [availCells, setAvailCells] = useState(0)
  const offsetRef = useRef(0)
  let activeStart = 0
  let activeEnd = 0
  let total = 0
  for (const entry of entries) {
    if (entry.tab.id === props.activeId) {
      activeStart = total
      activeEnd = total + entry.cells
    }
    total += entry.cells + 1 // + the row gap; harmless surplus after the last tab
  }
  total = Math.max(0, total - 1)
  let offset = offsetRef.current
  if (availCells > 0) {
    if (activeEnd - offset > availCells) offset = activeEnd - availCells
    if (activeStart < offset) offset = activeStart
    offset = Math.max(0, Math.min(offset, Math.max(0, total - availCells)))
  } else {
    offset = 0
  }
  offsetRef.current = offset

  return (
    <box
      ref={(r: BoxRenderable | null) => {
        stripRef.current = r
      }}
      flexDirection="row"
      flexShrink={0}
      paddingLeft={1}
      overflow="hidden"
      backgroundColor={theme.backgroundElement}
      onSizeChange={() => setAvailCells(Math.max(0, (stripRef.current?.width ?? 0) - 1))}
    >
      <box flexDirection="row" gap={1} flexShrink={0} marginLeft={-offset}>
        {entries.map(({ tab, turn, chipShown, title }) => {
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
            <box key={tab.id} flexDirection="row" gap={0} flexShrink={0} onMouseUp={() => props.onSelect(tab.id)}>
              {/* Turn chip — tmux CHAT_TAB_STATUS_FORMAT's ●/✓/!/?/○. Shown
                  only once the turn detector has an actionable reading for the
                  tab. We deliberately skip absent and "unknown" readings: both
                  are placeholders with no information, so let the real state
                  (or the engine's native title) speak. Hidden while an
                  engine-owned live title is visibly carrying the same status. */}
              {chipShown ? (
                <text fg={turnColor} attributes={pulse ? TextAttributes.BOLD : undefined} wrapMode="none">
                  {`${TURN_GLYPHS[turn]} `}
                </text>
              ) : null}
              <text
                fg={pulse ? theme.success : tab.id === props.activeId ? theme.focusAccent : theme.textMuted}
                attributes={pulse || tab.id === props.activeId ? TextAttributes.BOLD : undefined}
                wrapMode="none"
              >
                {title}
              </text>
            </box>
          )
        })}
      </box>
    </box>
  )
}
