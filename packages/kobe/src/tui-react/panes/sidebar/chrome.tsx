/** @jsxImportSource @opentui/react */
/**
 * Shared sidebar chrome — the brand header, nav rail, view tabs, section
 * header, and zen chip, extracted from `panel.tsx` so the TREE sidebar
 * renders the exact same components instead of a lookalike (owner call
 * 2026-08-01: the tree keeps the flat sidebar's design language).
 */

import { MouseButton, TextAttributes } from "@opentui/core"
import { legendCap } from "../../../tui/lib/help-groups"
import { SIDEBAR_NAV_ITEMS, type SidebarNav } from "../../../tui/panes/sidebar/nav-core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"

export function SectionHeader(props: {
  label: string
  suffix?: string
  topPad?: boolean
  /** Leading glyph cell (the tree's project twisty). */
  prefix?: string
  onPress?: () => void
  /** Right-click, with the click's screen cell (the tree's project menu). */
  onContextMenu?: (x: number, y: number) => void
}) {
  const { theme, transparentBackground } = useTheme()
  const dividerColor = transparentBackground ? theme.border : theme.borderSubtle
  return (
    <box flexDirection="column" flexShrink={0}>
      {props.topPad ? (
        <box flexShrink={0}>
          <text wrapMode="none"> </text>
        </box>
      ) : null}
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        onMouseUp={
          props.onPress || props.onContextMenu
            ? (evt: { button: number; x: number; y: number }) => {
                if (evt.button === MouseButton.RIGHT && props.onContextMenu) {
                  props.onContextMenu(evt.x, evt.y)
                  return
                }
                props.onPress?.()
              }
            : undefined
        }
      >
        {props.prefix ? (
          <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
            {props.prefix}
          </text>
        ) : null}
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
          {props.label}
        </text>
        <text fg={dividerColor} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
          {"─".repeat(240)}
        </text>
        {props.suffix ? (
          <text fg={theme.info} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
            {props.suffix}
          </text>
        ) : null}
      </box>
    </box>
  )
}

/** The `/` query row. Shared by the flat sidebar and the tree so there is one
 *  search affordance rather than two lookalikes — the count suffix reads
 *  `matches/total` over whatever list the host is filtering. */
export function SidebarSearchInput(props: { query: string; matchCount: number; totalCount: number }) {
  const { theme } = useTheme()
  const t = useT()
  return (
    <box flexDirection="row" gap={0} flexShrink={0} paddingBottom={1} paddingLeft={1}>
      <text fg={theme.info} wrapMode="none">
        /
      </text>
      <text fg={theme.text} wrapMode="none">
        {props.query}
      </text>
      <text fg={theme.info} attributes={TextAttributes.BLINK} wrapMode="none">
        █
      </text>
      {props.query.length === 0 ? (
        <text fg={theme.textMuted} wrapMode="none">
          {" "}
          {t("tasks.search.placeholder")}
        </text>
      ) : (
        <text fg={theme.textMuted} wrapMode="none">
          {" "}
          {props.matchCount}/{props.totalCount}
        </text>
      )}
    </box>
  )
}

/** KOBE brand text + inbox status — the rail's first row. The brand text IS
 *  the sidebar's focus signal (accent when focused) — there is no pane frame
 *  to carry it. Task creation gets its own labelled row below: a tiny header
 *  glyph read as decoration to first-time users. */
export function SidebarBrandHeader(props: {
  focused: boolean
  status: { label: string; emphasize: boolean } | null
  onStatusClick?: () => void
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={1}>
        <text fg={props.focused ? theme.focusAccent : theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
          ROVE
        </text>
        {props.status ? (
          <text
            fg={props.status.emphasize ? theme.warning : theme.textMuted}
            attributes={props.status.emphasize ? TextAttributes.BOLD : TextAttributes.DIM}
            wrapMode="none"
            onMouseUp={() => props.onStatusClick?.()}
          >
            {props.status.label}
          </text>
        ) : null}
      </box>
    </box>
  )
}

/** Persistent primary action for the sidebar. The full row is clickable and
 *  the keycap comes from the live keymap, so a rebound or disabled `task.new`
 *  binding never leaves stale instructions behind. */
export function SidebarCreateAction(props: { onAddTask?: () => void }) {
  const { theme, transparentBackground } = useTheme()
  const t = useT()
  const keycap = legendCap("task.new")
  if (!props.onAddTask) return null

  return (
    <box flexShrink={0} paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1}>
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={transparentBackground ? undefined : theme.backgroundElement}
        onMouseUp={() => props.onAddTask?.()}
      >
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
          +
        </text>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
          {t("tasks.menu.newTask")}
        </text>
        {keycap ? (
          <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none" flexShrink={0}>
            {keycap}
          </text>
        ) : null}
      </box>
    </box>
  )
}

/** Top-level rail: one destination per line (owner call 2026-08-01). The
 *  24-cell rail cannot fit three chips side by side — vertical scales. */
export function SidebarNavRail(props: { nav: SidebarNav; setNav: (nav: SidebarNav) => void }) {
  const { theme } = useTheme()
  const t = useT()
  return (
    <box flexDirection="column" flexShrink={0} paddingBottom={1}>
      {SIDEBAR_NAV_ITEMS.map((item) => {
        const active = props.nav === item.nav
        return (
          <box
            key={item.nav}
            flexDirection="row"
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={active ? theme.focusAccent : undefined}
            onMouseUp={(e: { stopPropagation(): void }) => {
              // goToNav hands focus to the page; a bubbled sidebar
              // focus-grab (the pane shell's onMouseUp) took it right back,
              // so keys typed "into the page" fired sidebar chords (d!).
              e.stopPropagation()
              props.setNav(item.nav)
            }}
          >
            <text
              // Contrast fg on the accent fill: `background` is alpha-0 in
              // transparent mode (invisible text); `backgroundElement`
              // stays opaque in every mode.
              fg={active ? theme.backgroundElement : theme.textMuted}
              attributes={active ? TextAttributes.BOLD : undefined}
              wrapMode="none"
              flexGrow={1}
            >
              {t(item.labelKey)}
            </text>
          </box>
        )
      })}
    </box>
  )
}

export function SidebarZenChip(props: { onZenClick?: () => void }) {
  const { theme } = useTheme()
  return (
    <box flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
      <text
        fg={theme.accent}
        attributes={TextAttributes.BOLD}
        wrapMode="none"
        onMouseUp={(e: { stopPropagation(): void }) => {
          // Don't bubble to the pane box's focus-grab (workspace host):
          // zen entry moves focus to the terminal; a bubbled sidebar
          // focus would instantly exit zen via the focus guard.
          e.stopPropagation()
          props.onZenClick?.()
        }}
      >
        ☯ ZEN
      </text>
    </box>
  )
}
