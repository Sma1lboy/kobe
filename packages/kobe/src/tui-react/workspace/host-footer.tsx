/** @jsxImportSource @opentui/react */
/**
 * The workspace's bottom line: per-vendor subscription quota, e.g.
 * `CLAUDE 5h 42% → 14:00 · 7d 12%   CODEX 7d 47% → 8/4 06:00`.
 *
 * Snapshot-only — this pane never fetches. It renders whatever the daemon's
 * quota cache last pushed on `usage.snapshot` (slow poll + backoff, see
 * kobe-daemon/src/daemon/quota-usage-cache.ts); a vendor with no readable
 * login simply never appears, and with no vendors at all the row is not
 * rendered, so nothing shifts on terminals that have nothing to show.
 *
 * `WorkspaceFrame` owns the column wrapper so `host.tsx` stays under the
 * file-size cap — same extraction reason as `host-sidebar.tsx`.
 */

import type { ReactNode } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { engineDisplayName } from "../../engine/interactive-command"
import { usageChips } from "../component/settings-dialog/usage-core"
import { useTheme } from "../context/theme"
import { useAccessor } from "../lib/use-accessor"

function UsageFooter(props: { orchestrator: RemoteOrchestrator }) {
  const { theme } = useTheme()
  const usage = useAccessor(props.orchestrator.usageSnapshotSignal())
  if (!usage || usage.size === 0) return null
  const toneColor = { ok: theme.textMuted, warn: theme.warning, crit: theme.error } as const
  const now = Date.now()
  return (
    <box flexDirection="row" flexShrink={0} height={1} paddingLeft={1} gap={2}>
      {[...usage.entries()].map(([vendor, snapshot]) => (
        <box key={vendor} flexDirection="row" gap={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {engineDisplayName(vendor).toUpperCase()}
          </text>
          {usageChips(snapshot, now).map((chip, i) => (
            <text key={chip.text} fg={toneColor[chip.tone]} wrapMode="none">
              {i === 0 ? chip.text : `· ${chip.text}`}
            </text>
          ))}
        </box>
      ))}
    </box>
  )
}

/** Sidebar | workspace | files row, with the quota line under it. */
export function WorkspaceFrame(props: { orchestrator: RemoteOrchestrator; children: ReactNode }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box flexDirection="row" flexGrow={1}>
        {props.children}
      </box>
      <UsageFooter orchestrator={props.orchestrator} />
    </box>
  )
}
