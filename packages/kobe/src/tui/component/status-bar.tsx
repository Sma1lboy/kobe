/**
 * Bottom status bar — agent-deck style. Left side: focused-pane label
 * + pane-local hotkeys. Right side: always-on global hotkeys. Reads
 * the focused pane from context so the parent doesn't need to thread
 * it through props.
 *
 * Extracted from `src/tui/app.tsx` during the Shell refactor.
 */

import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useFocus } from "../context/focus"
import { KobeKeymap, useCtrlCArmed } from "../context/keybindings"
import { useTheme } from "../context/theme"

/**
 * `[Key]` chip — agent-deck-style key affordance. The key is wrapped in
 * literal brackets in BOLD accent color; label follows in muted text.
 * No filled background → terminal shows through.
 */
function Hotkey(props: { keys: string; label: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
        [{props.keys}]
      </text>
      <text fg={theme.textMuted} wrapMode="none">
        {props.label}
      </text>
    </box>
  )
}

export function StatusBar() {
  const { theme } = useTheme()
  const focus = useFocus()
  const ctrlCArmed = useCtrlCArmed()
  const sectionLabel = () => {
    switch (focus.focused()) {
      case "sidebar":
        return "Tasks:"
      case "workspace":
        return "Chat:"
      case "files":
        return "Files:"
      case "terminal":
        return "Terminal:"
    }
  }
  // Pane-local hints come from KobeKeymap by scope; only rows with a
  // status-enabled, non-pinned `hint` and a `scope` matching the focused pane
  // show up. Help may still use `hint` rows that opt out of the footer.
  const leftHints = () =>
    KobeKeymap.filter((b) => {
      if (!b.hint || b.hint.pin || b.hint.status === false) return false
      return b.scope === focus.focused()
    })
  // Right column = status-enabled pinned hints; Help is the only permanent
  // escape hatch in the compact footer.
  const rightHints = KobeKeymap.filter((b) => b.hint?.pin === "right" && b.hint.status !== false)

  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {/* Left: section label + pane-local hotkeys (driven by KobeKeymap) */}
      <box flexDirection="row" gap={2} flexShrink={1}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          {sectionLabel()}
        </text>
        <For each={leftHints()}>{(b) => <Hotkey keys={b.hint!.keys} label={b.hint!.label} />}</For>
      </box>
      {/* Right: global hotkeys (always available). Driven by KobeKeymap's
          `pin: "right"` rows. When ctrl+c is armed for double-tap quit,
          a warning chip is added so the user knows the next ctrl+c
          will exit. (The real quit chord — sidebar `q` — surfaces in
          the LEFT column when sidebar is focused, so the right column
          is just for cross-pane reminders now.) */}
      <box flexDirection="row" gap={2} flexShrink={0}>
        <For each={rightHints}>{(b) => <Hotkey keys={b.hint!.keys} label={b.hint!.label} />}</For>
        <Show when={ctrlCArmed()}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
            Press Ctrl+C again to exit
          </text>
        </Show>
      </box>
    </box>
  )
}
