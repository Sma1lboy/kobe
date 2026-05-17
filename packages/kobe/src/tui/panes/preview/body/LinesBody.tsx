/**
 * Render `lines` ContentState — flat array of strings either in File
 * mode (raw content via FileLine) or Diff mode (unified-diff coloring
 * via DiffLine). Empty diff means the working tree matches base; we
 * surface a hint so the user knows the pane isn't broken.
 */

import type { ScrollBoxRenderable } from "@opentui/core"
import { type Accessor, For, Show, createMemo } from "solid-js"
import { useTheme } from "../../../context/theme"
import { DiffLine, FileLine } from "../DiffLine"
import type { ContentState } from "../content-state"
import type { PreviewMode } from "../state"

export function LinesBody(props: { content: Accessor<ContentState>; refSet: (r: ScrollBoxRenderable) => void }) {
  const { theme } = useTheme()
  const linesData = createMemo(() => {
    const c = props.content()
    if (c.kind !== "lines") return { lines: [] as string[], mode: "file" as PreviewMode }
    return { lines: c.lines, mode: c.mode }
  })
  const lines = createMemo(() => linesData().lines)
  const mode = createMemo(() => linesData().mode)
  const isEmpty = createMemo(() => mode() === "diff" && lines().length === 0)

  return (
    <Show
      when={!isEmpty()}
      fallback={
        <box paddingTop={1} paddingLeft={1}>
          <text fg={theme.textMuted}>(no diff — file matches base, press f for content)</text>
        </box>
      }
    >
      <scrollbox ref={props.refSet} flexGrow={1} scrollbarOptions={{ visible: false }}>
        <For each={lines()}>
          {(line) => (
            <Show when={mode() === "diff"} fallback={<FileLine text={line} />}>
              <DiffLine text={line} />
            </Show>
          )}
        </For>
      </scrollbox>
    </Show>
  )
}
