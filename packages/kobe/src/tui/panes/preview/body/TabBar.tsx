/**
 * Preview pane tab strip — one chip per open file, click to activate
 * or to close (`x` glyph). Hidden when the parent owns the strip via
 * `hideInternalTabs` (CenterTabStrip in `app.tsx`).
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show } from "solid-js"
import { useTheme } from "../../../context/theme"
import { type PreviewState, type PreviewTab, closeTab, openTab, tabLabel } from "../state"

export function TabBar(props: {
  tabs: Accessor<readonly PreviewTab[]>
  active: Accessor<PreviewTab | undefined>
  setState: (updater: (s: PreviewState) => PreviewState) => void
}) {
  const { theme } = useTheme()
  return (
    <Show when={props.tabs().length > 0}>
      <box flexDirection="row" gap={1} flexShrink={0} paddingTop={0} paddingBottom={1}>
        <For each={props.tabs()}>
          {(tab) => {
            const isActive = () => props.active()?.path === tab.path
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isActive() ? theme.primary : theme.backgroundElement}
                onMouseUp={() => {
                  // Click on the tab body activates it. The `x` glyph
                  // fires its own handler below and closes first via
                  // queueMicrotask so the parent's onMouseUp doesn't
                  // re-activate it.
                  props.setState((s) => openTab(s, tab.path, tab.mode))
                }}
              >
                <text
                  fg={isActive() ? theme.selectedListItemText : theme.text}
                  attributes={isActive() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {tabLabel(tab)}
                </text>
                <text
                  fg={isActive() ? theme.selectedListItemText : theme.textMuted}
                  onMouseUp={() => {
                    queueMicrotask(() => props.setState((s) => closeTab(s, tab.path)))
                  }}
                >
                  x
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}
