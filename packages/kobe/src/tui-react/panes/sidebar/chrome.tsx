/** @jsxImportSource @opentui/react */
/**
 * Shared sidebar chrome — the brand header, nav rail, view tabs, section
 * header, and zen chip, extracted from `panel.tsx` so the TREE sidebar
 * renders the exact same components instead of a lookalike (owner call
 * 2026-08-01: the tree keeps the flat sidebar's design language).
 */

import { TextAttributes } from "@opentui/core"
import type { SidebarView } from "../../../tui/panes/sidebar/groups"
import { SIDEBAR_NAV_ITEMS, type SidebarNav } from "../../../tui/panes/sidebar/nav-core"
import { VIEW_TABS, viewTabLabelKey } from "../../../tui/panes/sidebar/view-core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"

export function SectionHeader(props: {
  label: string
  suffix?: string
  topPad?: boolean
  /** Leading glyph cell (the tree's project twisty). */
  prefix?: string
  onPress?: () => void
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
        onMouseUp={props.onPress ? () => props.onPress?.() : undefined}
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

/** KOBE brand text + inbox status + [+] — the rail's first row. The brand
 *  text IS the sidebar's focus signal (accent when focused) — there is no
 *  pane frame to carry it. */
export function SidebarBrandHeader(props: {
  focused: boolean
  status: { label: string; emphasize: boolean } | null
  onStatusClick?: () => void
  onAddTask?: () => void
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={1}>
        <text fg={props.focused ? theme.focusAccent : theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
          KOBE
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
      {props.onAddTask ? (
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none" onMouseUp={() => props.onAddTask?.()}>
          [+]
        </text>
      ) : null}
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
            onMouseUp={() => props.setNav(item.nav)}
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

/** Workspace / Archives — filters the task list INSIDE the sidebar. */
export function SidebarViewTabs(props: { view: SidebarView; setView: (view: SidebarView) => void }) {
  const { theme } = useTheme()
  const t = useT()
  return (
    <box flexDirection="row" gap={1} flexShrink={0} paddingBottom={1} paddingLeft={1} paddingRight={1}>
      {VIEW_TABS.map((tab) => {
        const active = props.view === tab.view
        return (
          <box key={tab.view} flexShrink={0} onMouseUp={() => props.setView(tab.view)}>
            <text
              fg={active ? theme.text : theme.textMuted}
              attributes={active ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              {t(viewTabLabelKey(tab.view))}
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
