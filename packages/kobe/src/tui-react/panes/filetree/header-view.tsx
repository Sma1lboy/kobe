/** @jsxImportSource @opentui/react */
/**
 * React view for the file tree pane's header chrome — the `src/tui/panes/
 * filetree/header-view.tsx` counterpart (issue #15, G3): the optional
 * Zen / Create-PR action row, the All / Changes tab chips, and the
 * Changes-tab status legend. Pure render — tab state and actions stay in
 * the pane component.
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
  /** Optional Ops-pane chips (see FileTreeProps). */
  onZenToggle?: () => void
  onCreatePR?: () => void
}

export function FileTreeHeaderView(props: FileTreeHeaderProps) {
  const { theme } = useTheme()
  const t = useT()
  return (
    <>
      {/* Action row — sits above the All / Changes tabs so it's reachable
         from both tabs. Zen toggle sits left of Create PR (bound to `p`). */}
      {props.onZenToggle || props.onCreatePR ? (
        <box flexDirection="row" justifyContent="flex-end" gap={2} paddingBottom={1} flexShrink={0}>
          {props.onZenToggle ? (
            // stopPropagation: the chip click must NOT bubble to the host
            // pane box's own onMouseUp (workspace host focuses the files
            // pane there) — zen would toggle on and instantly exit via
            // the focus-leaves-workspace guard. A chip click is an
            // action, never a background pane click.
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={(e: { stopPropagation(): void }) => {
                e.stopPropagation()
                props.onZenToggle?.()
              }}
            >
              <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
                [~]
              </text>
              <text fg={theme.text} wrapMode="none">
                {t("files.actions.zen")}
              </text>
            </box>
          ) : null}
          {props.onCreatePR ? (
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={(e: { stopPropagation(): void }) => {
                e.stopPropagation()
                props.onCreatePR?.()
              }}
            >
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
      <box flexDirection="row" paddingBottom={0} flexShrink={0} gap={2}>
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
