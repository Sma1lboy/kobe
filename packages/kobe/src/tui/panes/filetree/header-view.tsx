import { t } from "@/tui/i18n"
import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { type FileTreeTab, TAB_ORDER, tabLabelKey } from "./keys-core"

export type FileTreeHeaderProps = {
  tab: FileTreeTab
  onSelectTab: (tab: FileTreeTab) => void
  cornerBadge: { text: string; active: boolean } | null
  onZenToggle?: () => void
  onCreatePR?: () => void
}

export function FileTreeHeaderView(props: FileTreeHeaderProps) {
  const { theme } = useTheme()
  return (
    <>
      {}
      <Show when={props.onZenToggle || props.onCreatePR}>
        <box flexDirection="row" justifyContent="flex-end" gap={2} paddingBottom={1} flexShrink={0}>
          <Show when={props.onZenToggle}>
            <box flexDirection="row" gap={1} onMouseUp={() => props.onZenToggle?.()}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
                [~]
              </text>
              <text fg={theme.text} wrapMode="none">
                {t("files.actions.zen")}
              </text>
            </box>
          </Show>
          <Show when={props.onCreatePR}>
            <box flexDirection="row" gap={1} onMouseUp={() => props.onCreatePR?.()}>
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
      {}
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
        {}
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
      {}
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
