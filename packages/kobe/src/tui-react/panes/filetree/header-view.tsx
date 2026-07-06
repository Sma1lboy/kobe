/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import { type FileTreeTab, TAB_ORDER, tabLabelKey } from "../../../tui/panes/filetree/keys-core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"

export type FileTreeHeaderProps = {
  tab: FileTreeTab
  onSelectTab: (tab: FileTreeTab) => void
  cornerBadge: { text: string; active: boolean } | null
  onZenToggle?: () => void
  onCreatePR?: () => void
}

export function FileTreeHeaderView(props: FileTreeHeaderProps) {
  const { theme } = useTheme()
  const t = useT()
  const badge = props.cornerBadge
  return (
    <>
      {}
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
      {}
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
        {}
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
      {}
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
