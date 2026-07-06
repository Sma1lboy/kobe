/** @jsxImportSource @opentui/react */
/**
 * Daemon build-version skew banner (React port of
 * `src/tui/component/version-skew-banner.tsx`, issue #15 G3). The visible,
 * NON-fatal signal that the running daemon is an older build than this
 * process: a thin full-width top strip (amber accent rule + BOLD CAPS
 * label + action hint) that auto-hides once the daemon matches again.
 * Theme tokens only, engine-neutral copy — full rationale in the Solid
 * header. React canon: props are plain values, not Accessors.
 */

import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"

export type VersionSkewBannerProps = {
  /** True when the daemon is running a different build than this process. */
  stale: boolean
  /** The daemon's reported build version (e.g. "0.7.3"), or null if unknown. */
  daemonVersion: string | null
  /** This process's own build version (e.g. "0.7.4"). */
  clientVersion: string
  /** Available width (cells) so the accent rule fills the strip. */
  width: number
}

export function VersionSkewBanner(props: VersionSkewBannerProps) {
  const { theme } = useTheme()
  const t = useT()
  if (!props.stale) return null
  // One-line action hint: terse + actionable, naming both versions and the
  // two commands that fix it (same copy as the Solid `versionSkewHint`).
  const daemon = props.daemonVersion ? `v${props.daemonVersion}` : t("update.skew.olderBuild")
  const hint = t("update.skew.hint", { daemon, clientVersion: props.clientVersion })
  // Accent rule spans the strip, clamped to the pane width minus the 1-cell
  // selection gutter; a small floor keeps it visible on a very narrow pane.
  const ruleWidth = Math.max(4, props.width - 2)
  return (
    // flexShrink={0} so the strip never gets squeezed away; it owns its own
    // rows at the very top of the pane.
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} paddingBottom={1}>
      {/* The amber accent rule — a warning-toned bar of `▔` (upper block)
          so it reads as a thin rule above the message, not a heavy fill. */}
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
