/**
 * Top-of-shell title bar — three equal-flex columns so the center sits
 * at the geometric midpoint regardless of the left brand width or the
 * right PR button width.
 *
 *   - Left:   `KobeCode vX.Y.Z` + optional `↑ update available` chip.
 *   - Center: active task's repo basename + branch (`repo / branch`).
 *   - Right:  CreatePRButton.
 *
 * Extracted from `src/tui/app.tsx` during the Shell refactor.
 */

import { spawnSync } from "node:child_process"
import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { type Accessor, Show, createMemo } from "solid-js"
import pkg from "../../../package.json" with { type: "json" }
import { type KobeOrchestrator, RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import type { Task } from "../../types/task.ts"
import { UPDATE_COMMAND, type UpdateInfo } from "../../version.ts"
import { useTheme } from "../context/theme"
import type { WorktreeOpener } from "../lib/worktree-opener"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { CreatePRButton } from "./create-pr-button"
import { OpenWorktreeButton } from "./open-worktree-button"
import { RcBridgeDialog } from "./rc-bridge-dialog"
import { activeTaskTopBarParts } from "./top-bar-helpers"
import { UpdateDialog } from "./update-dialog"

export function TopBar(props: {
  orchestrator: KobeOrchestrator
  activeTask: Accessor<Task | undefined>
  /**
   * Active chat tab id within the active task — threaded through so the
   * RC bridge dialog (opened from the chip) can re-bind on Enable when
   * the user has stopped+restarted from the same dialog.
   */
  activeChatTabId?: Accessor<string | null | undefined>
  updateInfo: Accessor<UpdateInfo | null>
  worktreeOpener: Accessor<WorktreeOpener | null>
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const renderer = useRenderer()
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
  const activeLabel = createMemo(() => activeTaskTopBarParts(props.activeTask()))

  async function confirmUpdate(): Promise<void> {
    const info = props.updateInfo()
    if (!info?.hasUpdate) return
    const ok = await DialogConfirm.show(
      dialog,
      `Update to v${info.latest}?`,
      "Closes kobe, runs the updater in this terminal, then exits. Relaunch kobe after it finishes.",
      "cancel",
      "update",
    )
    if (ok !== true) return

    try {
      renderer?.destroy()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("kobe: renderer.destroy() failed before update:", err)
    }
    process.stderr.write(`kobe: updating ${info.current} -> ${info.latest}\n`)
    process.stderr.write(`running: ${UPDATE_COMMAND}\n`)
    const result = spawnSync("sh", ["-c", UPDATE_COMMAND], { stdio: "inherit" })
    if (result.error) {
      process.stderr.write(`kobe: update failed to start: ${result.error.message}\n`)
      process.exit(1)
    }
    const code = result.status ?? 1
    if (code === 0) process.stderr.write("kobe: update complete. Relaunch kobe to use the new version.\n")
    else process.stderr.write(`kobe: update failed with exit code ${code}.\n`)
    process.exit(code)
  }

  return (
    <box flexDirection="row" paddingLeft={2} paddingRight={2} flexShrink={0}>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={1} justifyContent="flex-start">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          KobeCode
        </text>
        <text fg={theme.textMuted}>v{pkg.version}</text>
        {/* Update controls. `[Update]` performs the self-update after
            confirming and leaving alt-screen; the version chip opens
            the UpdateDialog with the install command + release notes.
            Only renders when the npm-registry check found a newer
            published version. Suppressed entirely in dev mode
            (KOBE_DEV=1, set by `bun run dev`). */}
        <Show when={props.updateInfo()?.hasUpdate}>
          <text
            fg={theme.warning}
            attributes={TextAttributes.BOLD}
            onMouseUp={() => {
              void confirmUpdate()
            }}
          >
            [Update]
          </text>
          <text
            fg={theme.warning}
            onMouseUp={() => {
              const info = props.updateInfo()
              if (info) UpdateDialog.show(dialog, info)
            }}
          >
            ↑ v{props.updateInfo()?.latest} available!
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
              if (orch) RcBridgeDialog.show(dialog, orch, rcBridge, props.activeTask, props.activeChatTabId)
            }}
          >
            ◉{" "}
            {rcBridge().state === "running"
              ? (rcBridge().bound?.taskTitle ?? rcBridge().envId ?? "RC")
              : "RC connecting…"}
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
          <Show when={activeLabel()}>
            {(label) => (
              <box flexDirection="row" gap={1} justifyContent="center">
                <Show when={label().repoName}>
                  <text
                    fg={label().branch ? theme.textMuted : theme.text}
                    attributes={label().branch ? undefined : TextAttributes.BOLD}
                    wrapMode="none"
                  >
                    {label().repoName}
                  </text>
                </Show>
                <Show when={label().repoName && label().branch}>
                  <text fg={theme.textMuted} wrapMode="none">
                    /
                  </text>
                </Show>
                <Show when={label().branch}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
                    {label().branch}
                  </text>
                </Show>
              </box>
            )}
          </Show>
        </Show>
      </box>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={2} justifyContent="flex-end">
        <OpenWorktreeButton activeTask={props.activeTask} opener={props.worktreeOpener} />
        <CreatePRButton orchestrator={props.orchestrator} activeTask={props.activeTask} />
      </box>
    </box>
  )
}
