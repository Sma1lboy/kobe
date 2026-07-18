/** @jsxImportSource @opentui/react */
/**
 * React view for the file tree pane's header chrome — the `src/tui/panes/
 * filetree/header-view.tsx` counterpart (issue #15, G3): the optional
 * Zen / Create-PR action row, the All / Changes tab chips, and the
 * Changes-tab status legend. Pure render — tab state and actions stay in
 * the pane component.
 */

import { TextAttributes } from "@opentui/core"
import type { GitScope } from "../../../tui/panes/filetree/git"
import { type FileTreeTab, TAB_ORDER, tabLabelKey } from "../../../tui/panes/filetree/keys-core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"

export type FileTreeHeaderProps = {
  /** The active tab. */
  tab: FileTreeTab
  /** Changes-tab scope (working ↔ branch vs base). */
  scope: GitScope
  /** Resolved Branch-scope base ref, or null when none resolved (Branch
   *  scope + `b` toggle are unavailable then). */
  base: string | null
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
         from both tabs. Zen toggle sits left of Create PR (bound to ctrl+p). */}
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
                [^P]
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
      {/* Status legend + scope line — only on the Changes tab. The scope
         line names the active view (working tree vs branch-vs-base) and,
         when a base resolved, the `b` toggle affordance. */}
      {props.tab === "changes" ? (
        <box flexDirection="column" paddingBottom={1} flexShrink={0} gap={0}>
          <text fg={theme.textMuted} wrapMode="none">
            {props.scope === "branch" && props.base != null
              ? t("files.scope.branch", { base: props.base })
              : t("files.scope.working")}
            {props.base != null ? `  ${t("files.scope.toggleHint")}` : ""}
          </text>
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
