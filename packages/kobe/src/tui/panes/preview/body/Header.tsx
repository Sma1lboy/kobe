/**
 * Preview pane header — shows the active file path + mode badge on the
 * left, the available keymap on the right. Re-renders whenever the
 * active tab or its mode changes; reads accessors directly inside JSX
 * so Solid tracks at field granularity (not just truthy-transitions).
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, Show } from "solid-js"
import { useTheme } from "../../../context/theme"
import type { PreviewTab } from "../state"

export function Header(props: { active: Accessor<PreviewTab | undefined> }) {
  const { theme } = useTheme()
  const label = () => {
    const a = props.active()
    if (!a) return ""
    return `${a.path}`
  }
  const mode = () => props.active()?.mode ?? ""
  const hasActive = () => Boolean(props.active())
  return (
    <box flexDirection="row" justifyContent="space-between" paddingTop={1} paddingBottom={0} flexShrink={0}>
      <Show when={hasActive()} fallback={<text fg={theme.textMuted}>preview</text>}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {label()} <span style={{ fg: theme.textMuted }}>· {mode()}</span>
        </text>
      </Show>
      <text fg={theme.textMuted} wrapMode="none">
        f file · d diff · ctrl+w close · tab next
      </text>
    </box>
  )
}
