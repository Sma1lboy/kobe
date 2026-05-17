/**
 * Render a tokenized XML/SVG document as colored text rows. Each token
 * picks a theme color based on its kind; whitespace and unknown
 * content are rendered without styling so the visible diff vs. plain
 * text is limited to genuinely-meaningful tokens.
 *
 * Wrapped in a scrollbox to match `LinesBody` so the body scroll
 * keymap still works on highlighted documents.
 */

import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { type Accessor, For, Show, createMemo } from "solid-js"
import { useTheme } from "../../../context/theme"
import type { ContentState } from "../content-state"
import type { XmlToken } from "../xml-highlight"

export function XmlBody(props: { content: Accessor<ContentState>; refSet: (r: ScrollBoxRenderable) => void }) {
  const { theme } = useTheme()
  const rows = createMemo<XmlToken[][]>(() => {
    const c = props.content()
    return c.kind === "xml" ? c.rows : []
  })
  const colorFor = (kind: XmlToken["kind"]): RGBA => {
    switch (kind) {
      case "tag-delim":
        return theme.accent
      case "tag-name":
        return theme.info
      case "attr-name":
        return theme.warning
      case "attr-eq":
        return theme.textMuted
      case "attr-value":
        return theme.success
      case "comment":
      case "cdata":
      case "doctype":
        return theme.textMuted
      default:
        return theme.text
    }
  }
  return (
    <scrollbox ref={props.refSet} flexGrow={1} scrollbarOptions={{ visible: false }}>
      <For each={rows()}>
        {(row) => (
          <box paddingLeft={1} paddingRight={1}>
            <text wrapMode="none">
              <For each={row}>{(tok) => <span style={{ fg: colorFor(tok.kind) }}>{tok.text}</span>}</For>
              <Show when={row.length === 0}> </Show>
            </text>
          </box>
        )}
      </For>
    </scrollbox>
  )
}
