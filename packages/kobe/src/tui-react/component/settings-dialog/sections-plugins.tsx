/** @jsxImportSource @opentui/react */
/**
 * Settings → Plugins. One dense two-line block per registered plugin: a
 * navigable toggle row (`[x] id v0.1.0 owner/repo`) plus a muted detail
 * line (what it declares + its last hook run). Data comes from
 * `./plugins-core` — this file only maps rows to boxes.
 */

import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { type PluginRowView, formatAgo } from "./plugins-core"
import type { SectionCursorProps } from "./rows"

export function PluginSettingsSection(
  props: SectionCursorProps & {
    plugins: readonly PluginRowView[]
    /** Enter / click on a plugin row — flips its enabled flag. */
    toggle: (id: string) => void
  },
) {
  const { theme } = useTheme()
  const t = useT()
  const now = Date.now()
  const isBodyCursor = (row: number) => props.level === "body" && props.bodyRow === row
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {t("settings.plugins.title")}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("settings.plugins.hint")}
      </text>
      {props.plugins.length === 0 ? (
        <text fg={theme.textMuted} wrapMode="word">
          {t("settings.plugins.empty")}
        </text>
      ) : (
        <box flexDirection="column" gap={0}>
          {props.plugins.map((plugin, i) => {
            const isCursor = isBodyCursor(i)
            return (
              <box key={plugin.id} flexDirection="column" gap={0}>
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isCursor ? theme.primary : undefined}
                  onMouseUp={() => {
                    props.setLevel("body")
                    props.setBodyRow(i)
                    props.toggle(plugin.id)
                  }}
                >
                  <text
                    fg={isCursor ? theme.selectedListItemText : plugin.enabled ? theme.accent : theme.textMuted}
                    attributes={TextAttributes.BOLD}
                    wrapMode="none"
                  >
                    {`${plugin.enabled ? "[x]" : "[ ]"} ${plugin.id}`}
                  </text>
                  <text fg={isCursor ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                    {`v${plugin.version}  ${
                      plugin.linked
                        ? t("settings.plugins.sourceLink", { path: plugin.source })
                        : t("settings.plugins.sourceGithub", { spec: plugin.source })
                    }`}
                  </text>
                </box>
                <box flexDirection="row" gap={1} paddingLeft={5} paddingRight={1}>
                  <text fg={plugin.declares ? theme.textMuted : theme.warning} wrapMode="none">
                    {plugin.declares
                      ? t("settings.plugins.declares", {
                          actions: String(plugin.declares.actions),
                          events: String(plugin.declares.events),
                          panes: String(plugin.declares.panes),
                        })
                      : t("settings.plugins.manifestUnreadable")}
                  </text>
                  <text fg={plugin.lastRun?.ok === false ? theme.error : theme.textMuted} wrapMode="none">
                    {plugin.lastRun
                      ? t("settings.plugins.lastRun", {
                          label: plugin.lastRun.label,
                          status: plugin.lastRun.ok
                            ? t("settings.plugins.runOk")
                            : plugin.lastRun.spawnError
                              ? t("settings.plugins.runFailed")
                              : t("settings.plugins.runExit", { code: String(plugin.lastRun.exitCode) }),
                          ago: formatAgo(now - plugin.lastRun.at),
                        })
                      : t("settings.plugins.neverRun")}
                  </text>
                </box>
              </box>
            )
          })}
        </box>
      )}
    </box>
  )
}
