/**
 * Top-of-shell title bar (v0.6).
 *
 * Three equal-flex columns:
 *   - Left:   `KobeCode vX.Y.Z` + optional `↑ update available` chip.
 *   - Center: active task's repo basename + branch (`repo / branch`).
 *   - Right:  reserved for future Ops chips (KOB-230).
 *
 * v0.5's `CreatePRButton` / `OpenWorktreeButton` / `RcBridge` chip
 * are gone — KOB-232 brings PR back via the Ops pane; rc-bridge is
 * dropped entirely.
 */

import { spawnSync } from "node:child_process"
import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { type Accessor, Show, createMemo } from "solid-js"
import pkg from "../../../package.json" with { type: "json" }
import { type KobeOrchestrator, RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import type { Task } from "../../types/task.ts"
import { CURRENT_VERSION, UPDATE_COMMAND, type UpdateInfo } from "../../version.ts"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { activeTaskTopBarParts } from "./top-bar-helpers"

export function TopBar(props: {
  orchestrator: KobeOrchestrator
  activeTask: Accessor<Task | undefined>
  updateInfo: Accessor<UpdateInfo | null>
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const renderer = useRenderer()
  const connectionState = createMemo<"online" | "disconnected">(() => {
    const orch = props.orchestrator
    return orch instanceof RemoteOrchestrator ? orch.connectionStateSignal()() : "online"
  })
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
        <Show when={props.updateInfo()?.hasUpdate}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD} onMouseUp={() => void confirmUpdate()}>
            [Update]
          </text>
          <text fg={theme.warning} onMouseUp={() => void confirmUpdate()}>
            ↑ v{props.updateInfo()?.latest} available!
          </text>
        </Show>
      </box>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={1} justifyContent="center">
        <Show
          when={connectionState() === "online"}
          fallback={
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
        {/* Right slot reserved for v0.6.x Ops chips (KOB-230). */}
      </box>
    </box>
  )
}

// Avoid an unused-import lint warning for pkg until we surface more
// version-bound copy. The version chip above already consumes it.
void pkg
