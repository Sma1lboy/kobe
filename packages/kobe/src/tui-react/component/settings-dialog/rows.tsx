/** @jsxImportSource @opentui/react */

import { type RGBA, TextAttributes } from "@opentui/core"
import type { ReactNode } from "react"
import { useTheme } from "../../context/theme"

export function Row(props: {
  cursor: boolean
  onMouseUp: () => void
  fg: RGBA
  bold?: boolean
  idleBackground?: RGBA
  children?: ReactNode
}) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="row"
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.cursor ? theme.primary : props.idleBackground}
      onMouseUp={props.onMouseUp}
    >
      <text
        fg={props.cursor ? theme.selectedListItemText : props.fg}
        attributes={props.bold ? TextAttributes.BOLD : undefined}
        wrapMode="none"
      >
        {props.children}
      </text>
    </box>
  )
}

export function SubSection(props: { title: string; hint: string; paddingTop?: number; children?: ReactNode }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={0} paddingTop={props.paddingTop ?? 1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {props.hint}
      </text>
      {props.children}
    </box>
  )
}

export type SectionCursorProps = {
  level: "sidebar" | "body"
  bodyRow: number
  setLevel: (level: "sidebar" | "body") => void
  setBodyRow: (row: number) => void
}
