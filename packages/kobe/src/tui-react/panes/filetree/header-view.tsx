/** @jsxImportSource @opentui/react */
/**
 * React view for the file tree pane's header chrome — the `src/tui/panes/
 * filetree/header-view.tsx` counterpart (issue #15, G3): the optional
 * Zen / Create-PR action row, the All / Changes tab chips, the corner
 * activity badge (KOB-254), and the Changes-tab status legend. Pure
 * render — tab state and actions stay in the pane component.
 */

import { TextAttributes } from "@opentui/core"
import { type FileTreeTab, TAB_ORDER, tabLabelKey } from "../../../tui/panes/filetree/keys-core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"

export type FileTreeHeaderProps = {
  /** The active tab. */
  tab: FileTreeTab
  /** Mouse tab switch. */
  onSelectTab: (tab: FileTreeTab) => void
  /** Right-aligned activity badge; `null` hides it. */
  cornerBadge: { text: string; active: boolean } | null
  /** Optional Ops-pane chips (see FileTreeProps). */
  onZenToggle?: () => void
  onCreatePR?: () => void
}

export function FileTreeHeaderView(props: FileTreeHeaderProps) {
  const { theme } = useTheme()
  const t = useT()
  const badge = props.cornerBadge
  return (
    <>
      {/* Action row — sits above the All / Changes tabs so it's reachable
         from both tabs. Zen toggle sits left of Create PR (bound to `p`). */}
      {props.onZenToggle || props.onCreatePR ? (
        <box flexDirection="row" justifyContent="flex-end" gap={2} paddingBottom={1} flexShrink={0}>
          {props.onZenToggle ? (
            <box flexDirection="row" gap={1} onMouseUp={() => props.onZenToggle?.()}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
                [~]
              </text>
              <text fg={theme.text} wrapMode="none">
                {t("files.actions.zen")}
              </text>
            </box>
          ) : null}
          {props.onCreatePR ? (
            <box flexDirection="row" gap={1} onMouseUp={() => props.onCreatePR?.()}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
                [P]
              </text>
              <text fg={theme.text} wrapMode="none">
                {t("files.actions.createPR")}
              </text>
            </box>
          ) : null}
        </box>
      ) : null}
      {/* Header: tabs row. Each tab is clickable (sets active), and
         `[` / `]` cycle from the keyboard. */}
      <box flexDirection="row" justifyContent="space-between" paddingBottom={0} flexShrink={0}>
        <box flexDirection="row" gap={2}>
          {TAB_ORDER.map((tabId) => {
            const isActive = props.tab === tabId
            return (
              <text
                key={tabId}
                fg={isActive ? theme.primary : theme.textMuted}
                attributes={isActive ? TextAttributes.BOLD : undefined}
                wrapMode="none"
                onMouseUp={() => props.onSelectTab(tabId)}
              >
                {t(tabLabelKey(tabId))}
              </text>
            )
          })}
        </box>
        {/* Right-aligned activity badge (KOB-254). No background fill so
           it stays clean in transparent mode. */}
        {badge ? (
          <text
            fg={badge.active ? theme.accent : theme.textMuted}
            attributes={badge.active ? TextAttributes.BOLD : undefined}
            wrapMode="none"
          >
            {badge.text}
          </text>
        ) : null}
      </box>
      {/* Status legend — only shown on the Changes tab so users can
         decode single-char git status codes without leaving the TUI. */}
      {props.tab === "changes" ? (
        <box flexDirection="column" paddingBottom={1} flexShrink={0} gap={0}>
          <text fg={theme.textMuted} wrapMode="none">
            {t("files.legend.changes")}
          </text>
        </box>
      ) : (
        <box flexDirection="row" paddingBottom={1} flexShrink={0} />
      )}
    </>
  )
}
