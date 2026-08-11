/** @jsxImportSource @opentui/react */
/**
 * The workspace's bottom line: per-vendor subscription quota on the left,
 * e.g. `CLAUDE 5h 42% → 14:00 · 7d 12%   CODEX 7d 47% → 8/4 06:00`, and the
 * keyboard micro-hint (`⌃ A commands · F1 help`) on the right.
 *
 * Usage is snapshot-only — this pane never fetches. It renders whatever the
 * daemon's quota cache last pushed on `usage.snapshot` (slow poll + backoff,
 * see kobe-daemon/src/daemon/quota-usage-cache.ts); a vendor with no
 * readable login simply never appears. The hint resolves through the live
 * keymap/reachability (component/keyboard-hints.tsx). With no vendors AND
 * the hint muted, the row is not rendered, so nothing shifts on terminals
 * that have nothing to show.
 *
 * `WorkspaceFrame` owns the column wrapper so `host.tsx` stays under the
 * file-size cap — same extraction reason as `host-sidebar.tsx`.
 */

import { useTerminalDimensions } from "@opentui/react"
import type { ReactNode } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { engineDisplayName } from "../../engine/interactive-command"
import { StatusKeyHintBar, useStatusKeyHintItems } from "../component/keyboard-hints"
import { narrowUsageChip, usageChips } from "../component/settings-dialog/usage-core"
import { useTheme } from "../context/theme"
import { isNarrowWidth } from "../lib/narrow-mode"
import { useAccessor } from "../lib/use-accessor"

function UsageChips(props: { orchestrator: RemoteOrchestrator; narrow: boolean }) {
  const { theme } = useTheme()
  const usage = useAccessor(props.orchestrator.usageSnapshotSignal())
  if (!usage || usage.size === 0) return null
  const toneColor = { ok: theme.success, warn: theme.warning, crit: theme.error } as const
  const now = Date.now()
  if (props.narrow) {
    // Narrow footer (issue #14): one session-window chip per vendor —
    // `CLAUDE 42%` — tone color kept, label/reset dropped for the cells.
    return (
      <box flexDirection="row" gap={2}>
        {[...usage.entries()].flatMap(([vendor, snapshot]) => {
          const chip = narrowUsageChip(snapshot, now)
          if (!chip) return []
          return [
            <box key={vendor} flexDirection="row" gap={1}>
              <text fg={theme.textMuted} wrapMode="none">
                {engineDisplayName(vendor).toUpperCase()}
              </text>
              <text fg={toneColor[chip.tone]} wrapMode="none">
                {chip.percentText}
              </text>
            </box>,
          ]
        })}
      </box>
    )
  }
  return (
    <box flexDirection="row" gap={2}>
      {[...usage.entries()].map(([vendor, snapshot]) => (
        <box key={vendor} flexDirection="row" gap={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {engineDisplayName(vendor).toUpperCase()}
          </text>
          {usageChips(snapshot, now).map((chip, i) => (
            <box key={chip.label} flexDirection="row" gap={1}>
              <text fg={theme.textMuted} wrapMode="none">
                {i === 0 ? chip.label : `· ${chip.label}`}
              </text>
              <text fg={toneColor[chip.tone]} wrapMode="none">
                {chip.percentText}
              </text>
              {chip.resetText ? (
                <text fg={theme.textMuted} wrapMode="none">
                  {chip.resetText}
                </text>
              ) : null}
            </box>
          ))}
        </box>
      ))}
    </box>
  )
}

/** Sidebar | workspace | files row, with the quota + key-hint line under it. */
export function WorkspaceFrame(props: {
  orchestrator: RemoteOrchestrator
  /** Wires the footer's clickable [settings] button; absent = no settings segment. */
  onOpenSettings?: () => void
  children: ReactNode
}) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const narrow = isNarrowWidth(dims.width)
  const usage = useAccessor(props.orchestrator.usageSnapshotSignal())
  const hintItems = useStatusKeyHintItems({ onOpenSettings: props.onOpenSettings })
  const footerVisible = (usage != null && usage.size > 0) || hintItems.length > 0
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box flexDirection="row" flexGrow={1}>
        {props.children}
      </box>
      {footerVisible ? (
        <box flexDirection="row" flexShrink={0} height={1} paddingLeft={1} paddingRight={1} gap={2}>
          <box flexGrow={1} flexDirection="row">
            <UsageChips orchestrator={props.orchestrator} narrow={narrow} />
          </box>
          {/* Narrow drops the verbs and the [settings] chip: `⌃A · F1`. */}
          <StatusKeyHintBar onOpenSettings={narrow ? undefined : props.onOpenSettings} compact={narrow} />
        </box>
      ) : null}
    </box>
  )
}
