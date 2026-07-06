/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"

export type VersionSkewBannerProps = {
  stale: boolean
  daemonVersion: string | null
  clientVersion: string
  width: number
}

export function VersionSkewBanner(props: VersionSkewBannerProps) {
  const { theme } = useTheme()
  const t = useT()
  if (!props.stale) return null
  const daemon = props.daemonVersion ? `v${props.daemonVersion}` : t("update.skew.olderBuild")
  const hint = t("update.skew.hint", { daemon, clientVersion: props.clientVersion })
  const ruleWidth = Math.max(4, props.width - 2)
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} paddingBottom={1}>
      {}
      <text fg={theme.warning} wrapMode="none">
        {"▔".repeat(ruleWidth)}
      </text>
      <box flexDirection="row" gap={1}>
        <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
          {t("update.skew.title")}
        </text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text} wrapMode="word">
          {hint}
        </text>
      </box>
    </box>
  )
}
