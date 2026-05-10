/**
 * Uniform CAPS-bold pane label (agent-deck-style chunking).
 *
 * Focused panes paint in `theme.focusAccent` — a user-controllable
 * slot (Settings → General → Focus accent) that resolves to one of
 * primary / success / info. Default is primary (terracotta under
 * Claude's palette), which doubles as the brand hue. The leading
 * `▌` block character used to be the visibility hammer; we replaced
 * it with a focusAccent-colored ordinal so the active pane is
 * unmistakable without an extra leading glyph.
 *
 * Extracted from `src/tui/app.tsx` during the Shell refactor.
 */

import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "../context/theme"

export function PaneHeader(props: {
  title: string
  subtitle?: string
  /** Far-right hint (e.g. context %). Shown after `subtitle` when both exist. */
  asideRight?: string
  focused?: boolean
  ordinal?: string | number
}) {
  const { theme } = useTheme()
  const focused = () => props.focused !== false
  const titleColor = () => (focused() ? theme.focusAccent : theme.textMuted)
  const hasRight = () => Boolean(props.subtitle) || Boolean(props.asideRight)
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      flexShrink={0}
      // paddingTop=1 mirrors the Sidebar pane's outer paddingTop so
      // all four pane titles sit at the same baseline row. The
      // ordinal sits flush at the left edge (no ▌ marker, no extra
      // gap) — earlier the `▌ <ord> <title>` shape with gap=1
      // produced two cells of whitespace before the digit and the
      // four markers visually drifted out of alignment by a column.
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="row" gap={1} flexShrink={1}>
        {/* Ordinal flush left — plain BOLD; the focus-tracking color
            (focusAccent vs textMuted) is what flags this digit as the
            ctrl+N chord target. The underline variant felt visually
            noisy at title-row scale. */}
        <Show when={props.ordinal !== undefined}>
          <text fg={titleColor()} attributes={TextAttributes.BOLD} wrapMode="none">
            {props.ordinal}
          </text>
        </Show>
        <text fg={titleColor()} attributes={TextAttributes.BOLD} wrapMode="none">
          {props.title}
        </text>
      </box>
      <Show when={hasRight()}>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={props.subtitle}>
            <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
              {props.subtitle}
            </text>
          </Show>
          <Show when={props.asideRight}>
            <text fg={theme.textMuted} wrapMode="none">
              {props.asideRight}
            </text>
          </Show>
        </box>
      </Show>
    </box>
  )
}
