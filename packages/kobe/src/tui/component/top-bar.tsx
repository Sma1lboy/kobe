/**
 * Top-of-shell title bar — three equal-flex columns so the center sits
 * at the geometric midpoint regardless of the left brand width or the
 * right PR button width.
 *
 *   - Left:   `KobeCode vX.Y.Z` + optional `↑ update available` chip.
 *   - Center: active task's branch name (no "Repo <name>" prefix —
 *             kobe spans many repos so a single repo label in the
 *             topbar is misleading; the active branch alone is the
 *             useful per-task signal).
 *   - Right:  CreatePRButton.
 *
 * Extracted from `src/tui/app.tsx` during the Shell refactor.
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, Show, createMemo } from "solid-js"
import pkg from "../../../package.json" with { type: "json" }
import { type KobeOrchestrator, RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import type { Task } from "../../types/task.ts"
import type { UpdateInfo } from "../../version.ts"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { CreatePRButton } from "./create-pr-button"
import { RcBridgeDialog } from "./rc-bridge-dialog"
import { UpdateDialog } from "./update-dialog"

export function TopBar(props: {
  orchestrator: KobeOrchestrator
  activeTask: Accessor<Task | undefined>
  updateInfo: Accessor<UpdateInfo | null>
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  // KOB-38: only the daemon-backed orchestrator has a wire to lose.
  // The in-process Orchestrator (KOBE_NO_DAEMON / test engine) always
  // reports `online` so the banner never paints. Two states only —
  // the disconnect modal handles the "what next" choice.
  const connectionState = createMemo<"online" | "disconnected">(() => {
    const orch = props.orchestrator
    return orch instanceof RemoteOrchestrator ? orch.connectionStateSignal()() : "online"
  })
  // KOB-62 bridge chip — daemon-only (in-process Orchestrator returns
  // a permanently-"off" stub, so the chip would never render anyway —
  // but capturing the typed RemoteOrchestrator here avoids a cast
  // when handing it to RcBridgeDialog).
  const remoteOrch = props.orchestrator instanceof RemoteOrchestrator ? props.orchestrator : null
  const rcBridge = props.orchestrator.rcBridgeSignal()
  const isBridgeOn = () => rcBridge().state === "running" || rcBridge().state === "starting"
  return (
    <box flexDirection="row" paddingLeft={2} paddingRight={2} flexShrink={0}>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={1} justifyContent="flex-start">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          KobeCode
        </text>
        <text fg={theme.textMuted}>v{pkg.version}</text>
        {/* Update chip — clickable: opens the UpdateDialog with the
            install command and the GitHub release notes for what's new.
            Only renders when the npm-registry check found a newer
            published version. Informational only — no auto-update.
            Suppressed entirely in dev mode (KOBE_DEV=1, set by
            `bun run dev`). */}
        <Show when={props.updateInfo()?.hasUpdate}>
          <text
            fg={theme.warning}
            attributes={TextAttributes.BOLD}
            onMouseUp={() => {
              const info = props.updateInfo()
              if (info) UpdateDialog.show(dialog, info)
            }}
          >
            ↑ v{props.updateInfo()?.latest} available
          </text>
        </Show>
        {/* Remote-control bridge chip (KOB-62) — visible only while
            the bridge is starting or running, so the user always sees
            that this machine is exposed to claude.ai. Click opens the
            same share dialog as the command palette entry. */}
        <Show when={remoteOrch && isBridgeOn()}>
          <text
            fg={theme.accent}
            attributes={TextAttributes.BOLD}
            onMouseUp={() => {
              const orch = remoteOrch
              if (orch) RcBridgeDialog.show(dialog, orch, rcBridge)
            }}
          >
            ◉ {rcBridge().state === "running" ? (rcBridge().envId ?? "RC") : "RC connecting…"}
          </text>
        </Show>
      </box>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={1} justifyContent="center">
        <Show
          when={connectionState() === "online"}
          fallback={
            // Disconnect indicator (KOB-38). The disconnect modal owns
            // the recovery flow; this red text is just a fallback signal
            // if the modal gets dismissed.
            <text fg={theme.error} attributes={TextAttributes.BOLD} wrapMode="none">
              daemon disconnected
            </text>
          }
        >
          <Show when={props.activeTask() !== undefined}>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
              {props.activeTask()?.branch}
            </text>
          </Show>
        </Show>
      </box>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} justifyContent="flex-end">
        <CreatePRButton orchestrator={props.orchestrator} activeTask={props.activeTask} />
      </box>
    </box>
  )
}
