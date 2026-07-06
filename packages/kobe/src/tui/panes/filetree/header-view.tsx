/**
 * Solid view for the file tree pane's header chrome — the optional
 * Zen / Create-PR action row, the All / Changes tab chips, the corner
 * activity badge (KOB-254), and the Changes-tab status legend. Split out
 * of `FileTree.tsx` (issue #15, G3; the component was over the 500-line
 * cap). Pure render — tab state and actions stay in the pane component.
 */

import { t } from "@/tui/i18n"
import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { type FileTreeTab, TAB_ORDER, tabLabelKey } from "./keys-core"

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
  return (
    <>
      {/* Action row — sits above the All / Changes tabs so it's reachable
         from both tabs. Zen toggle sits left of Create PR (bound to `p`). */}
      <Show when={props.onZenToggle || props.onCreatePR}>
        <box flexDirection="row" justifyContent="flex-end" gap={2} paddingBottom={1} flexShrink={0}>
          <Show when={props.onZenToggle}>
            {/* stopPropagation: the chip click must NOT bubble to the host
                pane box's own onMouseUp (workspace host focuses the files
                pane there) — zen would toggle on and instantly exit via
                the focus-leaves-workspace guard. A chip click is an
                action, never a background pane click. */}
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={(e) => {
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
          </Show>
          <Show when={props.onCreatePR}>
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={(e) => {
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
          </Show>
        </box>
      </Show>
      {/* Header: tabs row. Each tab is clickable (sets active), and
         `[` / `]` cycle from the keyboard. */}
      <box flexDirection="row" justifyContent="space-between" paddingBottom={0} flexShrink={0}>
        <box flexDirection="row" gap={2}>
          <For each={TAB_ORDER}>
            {(tabId) => {
              const isActive = () => props.tab === tabId
              return (
                <text
                  fg={isActive() ? theme.primary : theme.textMuted}
                  attributes={isActive() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  onMouseUp={() => props.onSelectTab(tabId)}
                >
                  {t(tabLabelKey(tabId))}
                </text>
              )
            }}
          </For>
        </box>
        {/* Right-aligned activity badge (KOB-254). No background fill so
           it stays clean in transparent mode. */}
        <Show when={props.cornerBadge}>
          {(badge) => (
            <text
              fg={badge().active ? theme.accent : theme.textMuted}
              attributes={badge().active ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              {badge().text}
            </text>
          )}
        </Show>
      </box>
      {/* Status legend — only shown on the Changes tab so users can
         decode single-char git status codes without leaving the TUI. */}
      <Show when={props.tab === "changes"}>
        <box flexDirection="column" paddingBottom={1} flexShrink={0} gap={0}>
          <text fg={theme.textMuted} wrapMode="none">
            {t("files.legend.changes")}
          </text>
        </box>
      </Show>
      <Show when={props.tab !== "changes"}>
        <box flexDirection="row" paddingBottom={1} flexShrink={0} />
      </Show>
    </>
  )
}
