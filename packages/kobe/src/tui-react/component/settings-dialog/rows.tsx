/** @jsxImportSource @opentui/react */
/**
 * Tiny presentational helpers shared by the React settings sections
 * (issue #15 G3). The Solid `sections.tsx` repeats the same row/box
 * markup per setting; the React port factors the repetition into `Row`
 * (one navigable/clickable line) and `SubSection` (BOLD title + muted
 * hint + rows) so each section file stays well under the size cap while
 * rendering the exact same boxes.
 */

import { type BoxRenderable, type RGBA, TextAttributes } from "@opentui/core"
import { type ReactNode, createContext, useContext, useEffect, useRef } from "react"
import { useTheme } from "../../context/theme"

/**
 * Cursor-follow channel: the dialog provides a reporter; whichever `Row`
 * currently carries the keyboard cursor hands its renderable up so the
 * owning scrollbox can keep it visible on short terminals.
 */
export const SettingsCursorElContext = createContext<((el: BoxRenderable | null) => void) | null>(null)

/**
 * One navigable settings row: cursor row paints `theme.primary` behind
 * `selectedListItemText`; otherwise the caller-computed `fg` over
 * `idleBackground` (undefined = transparent, `backgroundElement` for the
 * button-style Dev/Feedback rows).
 */
export function Row(props: {
  cursor: boolean
  onMouseUp: () => void
  /** Foreground when NOT the cursor row (the caller owns that logic). */
  fg: RGBA
  bold?: boolean
  idleBackground?: RGBA
  children?: ReactNode
}) {
  const { theme } = useTheme()
  const reportCursorEl = useContext(SettingsCursorElContext)
  const elRef = useRef<BoxRenderable | null>(null)
  const { cursor } = props
  useEffect(() => {
    if (cursor) reportCursorEl?.(elRef.current)
  }, [cursor, reportCursorEl])
  return (
    <box
      ref={(r: BoxRenderable | null) => {
        elRef.current = r
      }}
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

/** BOLD section title + word-wrapped muted hint, then the rows. */
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

/** Shared cursor-plumbing props every section receives from the dialog. */
export type SectionCursorProps = {
  level: "sidebar" | "body"
  bodyRow: number
  setLevel: (level: "sidebar" | "body") => void
  setBodyRow: (row: number) => void
}
