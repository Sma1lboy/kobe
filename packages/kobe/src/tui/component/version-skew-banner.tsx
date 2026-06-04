/**
 * Daemon build-version skew banner (KOB).
 *
 * Bun has no hot-reload: after `npm i -g @sma1lboy/kobe@latest`, the
 * already-running daemon keeps executing the OLD code in memory until
 * `kobe daemon restart`, and the in-tmux panes keep old code until
 * `kobe reload`. The wire-protocol negotiation only catches a BREAKING
 * change; a normal patch upgrade keeps the same protocol version, so a
 * stale-build daemon is otherwise invisible and silently masks fixes.
 *
 * This is the visible, NON-fatal signal for that skew: a thin full-width
 * top strip prompting the restart. It auto-hides the moment the daemon
 * matches again (the orchestrator clears `daemonStale` on a reconnect to a
 * restarted daemon), so there's no dismiss chord to maintain — the banner
 * is its own dismissal once the user runs the fix.
 *
 * Visual language borrowed from wakey's banner ideation: an amber/coral
 * accent rule + a mono-feel BOLD CAPS label + a quiet action hint. We map
 * the wakey palette onto kobe THEME TOKENS (not hardcoded hex) so it never
 * fights the active theme: `theme.warning` (amber) carries the label and
 * the accent rule; `theme.text` / `theme.textMuted` carry the copy.
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, Show } from "solid-js"
import { useTheme } from "../context/theme"

export type VersionSkewBannerProps = {
  /** True when the daemon is running a different build than this process. */
  stale: Accessor<boolean>
  /** The daemon's reported build version (e.g. "0.7.3"), or null if unknown. */
  daemonVersion: Accessor<string | null>
  /** This process's own build version (e.g. "0.7.4"). */
  clientVersion: string
  /**
   * Available width (cells) so the accent rule fills the strip and the copy
   * can be sized. The Tasks pane feeds its live tmux pane width here.
   */
  width: Accessor<number>
}

/**
 * One-line action hint. Terse + actionable, naming both versions and the two
 * commands that fix it. Engine-neutral — this is daemon/build version, no
 * vendor strings.
 */
export function versionSkewHint(daemonVersion: string | null, clientVersion: string): string {
  const daemon = daemonVersion ? `v${daemonVersion}` : "an older build"
  return `daemon is ${daemon} — you launched v${clientVersion}. Run \`kobe daemon restart\` then \`kobe reload\``
}

export function VersionSkewBanner(props: VersionSkewBannerProps) {
  const { theme } = useTheme()
  // Accent rule spans the strip. Clamp to the pane width minus the 1-cell
  // selection gutter the rest of the Tasks pane reserves, so the rule lines
  // up with the brand header / rows above it. A small floor keeps it visible
  // on an extremely narrow pane.
  const ruleWidth = (): number => Math.max(4, props.width() - 2)
  return (
    <Show when={props.stale()}>
      {/* flexShrink={0} so the strip never gets squeezed away when the task
          list grows; it owns its own two rows at the very top of the pane. */}
      <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} paddingBottom={1}>
        {/* The amber accent rule — wakey's gradient hairline, rendered as a
            solid warning-toned bar of `▔` (upper block) so it reads as a thin
            rule above the message rather than a heavy fill. */}
        <text fg={theme.warning} wrapMode="none">
          {"▔".repeat(ruleWidth())}
        </text>
        {/* Label row: BOLD CAPS warning chip + the action hint. The chip
            carries the warning tone; the hint stays in body text so the two
            versions + commands are legible, with the commands themselves
            picked out in the accent colour. */}
        <box flexDirection="row" gap={1}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
            ⚠ DAEMON OUT OF DATE
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
