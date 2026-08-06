/** @jsxImportSource @opentui/react */
/** Persistent Task-delegation chrome shared by the flat and tree sidebars. */

import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"

export function SubagentLinkGlyph(props: { readonly visible: boolean }) {
  const { theme } = useTheme()
  if (!props.visible) return null
  return (
    <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
      └
    </text>
  )
}

export function PrimarySubagentEntry(props: {
  readonly taskId: string
  readonly count: number
  readonly onOpen?: (taskId: string) => void
}) {
  const { theme } = useTheme()
  if (props.count <= 0) return null
  const label = `SUB ${props.count} ›`
  if (!props.onOpen) {
    return (
      <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
        {label}
      </text>
    )
  }
  return (
    <box
      flexShrink={0}
      onMouseUp={(event: { stopPropagation(): void }) => {
        event.stopPropagation()
        props.onOpen?.(props.taskId)
      }}
    >
      <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
        {label}
      </text>
    </box>
  )
}
