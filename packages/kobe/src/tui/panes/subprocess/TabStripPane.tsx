/**
 * Sprint-8 — tab-strip pane subprocess (Solid render).
 *
 * Horizontal chips for the active task's tabs. Each chip:
 *   inactive →  Tab label
 *   active   → [Tab label]   (bracketed + bold + primary fg)
 *
 * Falls back to a muted "no active task" line when no task is active.
 */

import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import type { PaneSignals } from "./shared"

interface ChatTabLike {
  readonly id: string
  readonly seq: number
  readonly title?: string
}

function tabLabel(tab: ChatTabLike): string {
  if (tab.title && tab.title.length > 0) return tab.title
  return `chat ${tab.seq}`
}

export function TabStripPane(props: { signals: PaneSignals }) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="row"
      flexGrow={1}
      backgroundColor={theme.background}
      paddingLeft={1}
      paddingRight={1}
      gap={1}
      alignItems="center"
    >
      <Show
        when={props.signals.activeTask() !== null}
        fallback={
          <text fg={theme.textMuted} wrapMode="none">
            no active task
          </text>
        }
      >
        {(() => {
          const active = () => props.signals.activeTask()
          const tabs = () => (active()?.tabs ?? []) as readonly ChatTabLike[]
          const activeTabId = () => active()?.activeTabId
          return (
            <For each={tabs()}>
              {(tab) => {
                const isActive = () => tab.id === activeTabId()
                // Mirror FileTree TAB-strip pattern: handler directly on
                // the <text>, no wrapper <box>. FileTree's tabs are known
                // to click reliably under tmux.
                const dispatch = () => {
                  if (isActive()) return
                  props.signals.dispatchRpc("rpc.switchTab", { tabId: tab.id })
                }
                return (
                  <text
                    fg={isActive() ? theme.primary : theme.textMuted}
                    attributes={isActive() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                    onMouseUp={dispatch}
                  >
                    {isActive() ? `[${tabLabel(tab)}]` : ` ${tabLabel(tab)} `}
                  </text>
                )
              }}
            </For>
          )
        })()}
      </Show>
    </box>
  )
}
