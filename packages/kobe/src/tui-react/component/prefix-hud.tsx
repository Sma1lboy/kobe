/** @jsxImportSource @opentui/react */
/**
 * Bottom-left prefix HUD (over the Tasks sidebar — NOT the terminal column,
 * where it collided with the engine's own status line): while the PureTUI
 * prefix is armed it shows a live `ctrl+a ⋯` line, and each resolved
 * sequence lands a `ctrl+a + t → tab.new` line (or `∅` on a miss). The last
 * three lines stream like a mini log and flush PREFIX_HUD_TTL_MS after they
 * land — flush timers live HERE; the framework-free feed only timestamps
 * (src/tui/lib/prefix-hud.ts), so headless dispatch stays timer-free.
 */

import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useState } from "react"
import { currentPrefixConfiguration } from "../../tui/lib/keymap-dispatch"
import { PREFIX_HUD_TTL_MS, prefixHudState } from "../../tui/lib/prefix-hud"
import { useTheme } from "../context/theme"
import { useAccessor } from "../lib/use-accessor"

const BOTTOM_MARGIN = 1

export function PrefixHud(props: { left: number; width: number }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const hud = useAccessor(prefixHudState)
  const [, setFlushTick] = useState(0)

  const now = Date.now()
  const fresh = hud.entries.filter((entry) => now - entry.at < PREFIX_HUD_TTL_MS)

  // Wake up when the oldest visible line crosses its TTL so it flushes out.
  const oldestAt = fresh[0]?.at
  useEffect(() => {
    if (oldestAt === undefined) return
    const timer = setTimeout(
      () => setFlushTick((tick) => tick + 1),
      Math.max(30, oldestAt + PREFIX_HUD_TTL_MS - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [oldestAt])

  const lineCount = fresh.length + (hud.armed ? 1 : 0)
  if (lineCount === 0) return null
  const top = Math.max(0, dims.height - BOTTOM_MARGIN - lineCount)
  const armedKey = currentPrefixConfiguration().key ?? ""

  return (
    <box position="absolute" zIndex={2400} left={props.left} top={top} width={props.width} flexDirection="column">
      {fresh.map((entry) => (
        <box key={entry.id} paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundPanel}>
          <text fg={entry.action ? theme.textMuted : theme.warning} wrapMode="none">
            {`${entry.prefixKey} + ${entry.stroke} ${entry.action ? `→ ${entry.action}` : "∅"}`}
          </text>
        </box>
      ))}
      {hud.armed ? (
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundPanel}>
          <text fg={theme.accent} wrapMode="none">
            {`${armedKey} ⋯`}
          </text>
        </box>
      ) : null}
    </box>
  )
}
