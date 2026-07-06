import { TextAttributes } from "@opentui/core"
import { type Accessor, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"

export type VersionSkewBannerProps = {
  stale: Accessor<boolean>
  daemonVersion: Accessor<string | null>
  clientVersion: string
  width: Accessor<number>
}

export function versionSkewHint(daemonVersion: string | null, clientVersion: string): string {
  const daemon = daemonVersion ? `v${daemonVersion}` : t("update.skew.olderBuild")
  return t("update.skew.hint", { daemon, clientVersion })
}

export function VersionSkewBanner(props: VersionSkewBannerProps) {
  const { theme } = useTheme()
  const ruleWidth = (): number => Math.max(4, props.width() - 2)
  return (
    <Show when={props.stale()}>
      {}
      <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} paddingBottom={1}>
        {}
        <text fg={theme.warning} wrapMode="none">
          {"▔".repeat(ruleWidth())}
        </text>
        {}
        <box flexDirection="row" gap={1}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
            {t("update.skew.title")}
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text} wrapMode="word">
            {versionSkewHint(props.daemonVersion(), props.clientVersion)}
          </text>
        </box>
      </box>
    </Show>
  )
}
