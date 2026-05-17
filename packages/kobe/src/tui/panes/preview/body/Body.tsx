/**
 * Switch dispatcher for the preview pane's main render area. The
 * parent component pushes a {@link ContentState} through `content`
 * and we route it to the right body subcomponent.
 *
 * Solid's `<Switch>` re-runs only when the discriminator changes —
 * exactly what we want here. An IIFE would have captured `content()`
 * at first render and never re-evaluated, so swapping File ↔ Diff
 * modes wouldn't surface in the rendered subtree. Each branch reads
 * `content()` again inside its sub-body to access the variant-specific
 * fields reactively.
 */

import type { ScrollBoxRenderable } from "@opentui/core"
import { type Accessor, Match, Switch, createMemo } from "solid-js"
import { useTheme } from "../../../context/theme"
import type { ContentState } from "../content-state"
import { ErrorBody } from "./ErrorBody"
import { LinesBody } from "./LinesBody"
import { MediaBody } from "./MediaBody"
import { XmlBody } from "./XmlBody"

export function Body(props: { content: Accessor<ContentState>; refSet: (r: ScrollBoxRenderable) => void }) {
  const { theme } = useTheme()
  const kind = createMemo(() => props.content().kind)
  return (
    <box flexGrow={1} minWidth={0}>
      <Switch>
        <Match when={kind() === "empty"}>
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>(open a file from the tree — enter)</text>
          </box>
        </Match>
        <Match when={kind() === "loading"}>
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>loading…</text>
          </box>
        </Match>
        <Match when={kind() === "error"}>
          <ErrorBody content={props.content} />
        </Match>
        <Match when={kind() === "lines"}>
          <LinesBody content={props.content} refSet={props.refSet} />
        </Match>
        <Match when={kind() === "media"}>
          <MediaBody content={props.content} />
        </Match>
        <Match when={kind() === "xml"}>
          <XmlBody content={props.content} refSet={props.refSet} />
        </Match>
      </Switch>
    </box>
  )
}
