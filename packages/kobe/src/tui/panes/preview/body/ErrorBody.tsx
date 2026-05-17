/**
 * Render an `error` ContentState. Hint-style messages (those wrapped
 * in `( … )` or referencing the `f`/`d` keys) get the muted theme
 * color so the red `error:` prefix stays reserved for actual failures.
 */

import type { Accessor } from "solid-js"
import { useTheme } from "../../../context/theme"
import type { ContentState } from "../content-state"

export function ErrorBody(props: { content: Accessor<ContentState> }) {
  const { theme } = useTheme()
  const message = () => {
    const c = props.content()
    return c.kind === "error" ? c.message : ""
  }
  const isHint = () => message().startsWith("(") || message().includes("press f")
  return (
    <box paddingTop={1} paddingLeft={1}>
      <text fg={isHint() ? theme.textMuted : theme.error} wrapMode="word">
        {isHint() ? message() : `error: ${message()}`}
      </text>
    </box>
  )
}
