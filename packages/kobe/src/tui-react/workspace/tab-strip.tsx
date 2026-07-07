/** @jsxImportSource @opentui/react */
/**
 * Workspace tab strip — React port of `tui/workspace/tab-strip.tsx` (issue
 * #16 React migration). The row of engine/command tabs above the embedded
 * terminal. Owns the per-tab turn chip and the turn-complete pulse: when a
 * tab's turn flips running→done, the chip and title flash emphasized for a
 * few frames before settling — a landing cue for work that finished while
 * you looked elsewhere.
 *
 * `tabTitle` is a plain (non-hook) helper — used both here and by
 * `TerminalTabs.tsx` outside render (rename dialog prefill, notification
 * titles) — so it reads the module-level `t()` rather than `useT()`.
 */

import { TextAttributes } from "@opentui/core"
import { useEffect, useRef, useState } from "react"
import { engineEntry } from "../../engine/registry"
import type { ChatTabTurnState } from "../../engine/turn-detector"
import { leaves } from "../../tui/workspace/split-core"
import { SHELL_LEAF_NAME, type TerminalTab, hasEngineLeaf } from "../../tui/workspace/terminal-tabs-core"
import type { VendorId } from "../../types/vendor"
import { useTheme } from "../context/theme"
import { t } from "../i18n"

/** Same glyph vocabulary as tmux's `CHAT_TAB_STATUS_FORMAT` (`@kobe_tab_state`). */
export const TURN_GLYPHS: Record<ChatTabTurnState, string> = {
  running: "●",
  done: "✓",
  error: "!",
  unknown: "?",
  idle: "○",
}

/** How long the running→done pulse stays emphasized. */
const DONE_PULSE_MS = 600

/**
 * Default tab names are "$process $ordinal" (owner naming 2026-07-07):
 * a tab IS a terminal, so its name says what runs in it — "claude 3",
 * "shell 5", "vim 2" — never an opaque "tab N". `liveName` is the tab's
 * live foreground-process display name from `useTurnPolls().liveTitles`;
 * engine tabs don't need it (their process is known by construction),
 * callers without it (notifications) fall back to the static shell default.
 */
export function tabTitle(tab: TerminalTab, taskVendor: VendorId, liveName?: string | null): string {
  // Manual rename always wins; a conversation's first-prompt title beats
  // the numbered default; a multi-leaf SPLIT tab is a "group N" (its
  // leaves carry the individual names — see splitLeafNames).
  if (tab.title) return tab.title
  const ls = tab.splitTree ? leaves(tab.splitTree.root) : []
  if (ls.length > 1) return t("terminal.tab.groupTitle", { n: tab.ordinal })
  // Collapsed to a single NON-engine leaf (you closed the engine leaf and
  // a shell survives) → that leaf's rename, else its live process name.
  const sole = ls.length === 1 ? ls[0] : undefined
  if (sole && sole.id !== "leaf-1") return sole.title ?? `${liveName ?? SHELL_LEAF_NAME} ${tab.ordinal}`
  if (tab.autoTitle) return tab.autoTitle
  const name =
    tab.kind === "engine"
      ? (engineEntry(tab.vendor ?? taskVendor).defaultCommand[0] ?? SHELL_LEAF_NAME)
      : (liveName ?? SHELL_LEAF_NAME)
  return `${name} ${tab.ordinal}`
}

export function TabStrip(props: {
  tabs: readonly TerminalTab[]
  activeId: string
  turnStates: ReadonlyMap<string, ChatTabTurnState>
  onSelect: (tabId: string) => void
  /** Task-level engine — the default-name fallback for unpinned tabs. */
  vendor: VendorId
  /** tabId → live process display name (see `useTurnPolls().liveTitles`). */
  liveTitles: ReadonlyMap<string, string>
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
        const pulse = pulsing.has(tab.id)
        const turnColor =
          turn === "running"
            ? theme.focusAccent
            : turn === "done"
              ? theme.success
              : turn === "error"
                ? theme.error
                : theme.textMuted
        return (
          <box key={tab.id} flexDirection="row" gap={0} onMouseUp={() => props.onSelect(tab.id)}>
            {/* Turn chip — tmux CHAT_TAB_STATUS_FORMAT's ●/✓/!/?/○.
                Shown when the tab's process IS an engine: kobe-launched
                (an engine tab whose engine leaf is alive — instant, by
                construction) or detected (a user-typed `claude` in a
                shell, which materializes a turnStates entry via the
                title-matched poll and disappears when it exits). */}
            {props.turnStates.has(tab.id) || (tab.kind === "engine" && hasEngineLeaf(tab.splitTree)) ? (
              <text fg={turnColor} attributes={pulse ? TextAttributes.BOLD : undefined} wrapMode="none">
                {`${TURN_GLYPHS[turn]} `}
              </text>
            ) : null}
            <text
              fg={pulse ? theme.success : tab.id === props.activeId ? theme.focusAccent : theme.textMuted}
              attributes={pulse || tab.id === props.activeId ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              {tabTitle(tab, props.vendor, props.liveTitles.get(tab.id))}
            </text>
          </box>
        )
      })}
    </box>
  )
}
