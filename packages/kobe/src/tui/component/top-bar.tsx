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
import { type Accessor, Show } from "solid-js"
import pkg from "../../../package.json" with { type: "json" }
import type { KobeOrchestrator } from "../../client/remote-orchestrator.ts"
import type { Task } from "../../types/task.ts"
import type { UpdateInfo } from "../../version.ts"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { CreatePRButton } from "./create-pr-button"
import { UpdateDialog } from "./update-dialog"

export function TopBar(props: {
  orchestrator: KobeOrchestrator
  activeTask: Accessor<Task | undefined>
  updateInfo: Accessor<UpdateInfo | null>
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
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
      </box>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={1} justifyContent="center">
        <Show when={props.activeTask() !== undefined}>
          <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
            {props.activeTask()?.branch}
          </text>
        </Show>
      </box>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} justifyContent="flex-end">
        <CreatePRButton orchestrator={props.orchestrator} activeTask={props.activeTask} />
      </box>
    </box>
  )
}
