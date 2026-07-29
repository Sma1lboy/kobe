/** @jsxImportSource @opentui/react */
/**
 * Settings → Plugins. One dense two-line block per registered plugin: a
 * navigable toggle row (`[x] id v0.1.0 owner/repo`) plus a muted detail
 * line (what it declares + its last hook run), then one indented row per
 * `[[settings]]` the manifest declares. Data comes from `./plugins-core` —
 * this file only maps rows to boxes.
 */

import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { type PluginSettingRowView, isBooleanOn } from "./plugin-settings-core"
import { type PluginRowView, formatAgo } from "./plugins-core"
import type { SectionCursorProps } from "./rows"

/**
 * Body-row index of each plugin's toggle row. A plugin owns
 * `1 + settings.length` consecutive rows, matching `pluginRows()` in the
 * shared model — the section's cursor math is that same layout.
 */
function toggleRowOffsets(plugins: readonly PluginRowView[]): number[] {
  const offsets: number[] = []
  let next = 0
  for (const plugin of plugins) {
    offsets.push(next)
    next += 1 + plugin.settings.length
  }
  return offsets
}

/**
 * One declared setting, indented under its plugin: `label  value`. The
 * label is plugin-owned copy (like an action title) so it renders raw;
 * only the fallback wording around it is ours.
 */
function SettingRow(props: { setting: PluginSettingRowView; cursor: boolean; onActivate: () => void }) {
  const { theme } = useTheme()
  const t = useT()
  const { setting } = props
  const value =
    setting.type === "boolean"
      ? isBooleanOn(setting.value)
        ? t("settings.general.on")
        : t("settings.general.off")
      : setting.value || t("settings.plugins.settingUnset")
  return (
    <box
      flexDirection="row"
      gap={1}
      paddingLeft={5}
      paddingRight={1}
      backgroundColor={props.cursor ? theme.primary : undefined}
      onMouseUp={props.onActivate}
    >
      <text fg={props.cursor ? theme.selectedListItemText : theme.text} wrapMode="none">
        {setting.label}
      </text>
      <text
        fg={props.cursor ? theme.selectedListItemText : setting.defaulted ? theme.textMuted : theme.accent}
        wrapMode="none"
      >
        {value}
      </text>
    </box>
  )
}

export function PluginSettingsSection(
  props: SectionCursorProps & {
    plugins: readonly PluginRowView[]
    /** Enter / click on a plugin row — flips its enabled flag. */
    toggle: (id: string) => void
    /** Enter / click on a setting row — cycles, flips, or prompts. */
    editSetting: (pluginId: string, key: string) => void
  },
) {
  const { theme } = useTheme()
  const t = useT()
  const now = Date.now()
  const isBodyCursor = (row: number) => props.level === "body" && props.bodyRow === row
  const offsets = toggleRowOffsets(props.plugins)
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
            const toggleRow = offsets[i] ?? 0
            const isCursor = isBodyCursor(toggleRow)
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
                    props.setBodyRow(toggleRow)
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
                {plugin.settings.map((setting, s) => (
                  <SettingRow
                    key={setting.key}
                    setting={setting}
                    cursor={isBodyCursor(toggleRow + 1 + s)}
                    onActivate={() => {
                      props.setLevel("body")
                      props.setBodyRow(toggleRow + 1 + s)
                      props.editSetting(plugin.id, setting.key)
                    }}
                  />
                ))}
              </box>
            )
          })}
        </box>
      )}
    </box>
  )
}
