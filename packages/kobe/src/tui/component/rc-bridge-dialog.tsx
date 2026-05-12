/**
 * "Share to claude.ai" dialog (KOB-62) — exposes the remote-control
 * bridge daemon to the user.
 *
 * What this is: kobed manages a single `claude remote-control` child
 * process (see `src/daemon/rc-bridge.ts`). When running, the bridge
 * registers this machine as an environment that claude.ai (web /
 * mobile) can spawn sessions onto. Cloud-side sessions execute under
 * the daemon's cwd with the user's local file/bash tools, so a session
 * started from the phone really runs on your laptop.
 *
 * What this is NOT: a way to migrate an in-flight kobe task into the
 * cloud. Bridge-spawned sessions are independent of kobe's task model
 * — they don't appear as kobe tabs, and we don't render their
 * conversation. They live entirely in claude.ai. (See the KOB-62 S1
 * comment for why; the worker JSONL is bridge-private and the worker
 * stdout never reaches us.)
 *
 * UX:
 *   - off       → "[ enter ] Enable" button. Click → start daemon, dialog
 *                 stays open and re-renders as state advances to "running".
 *   - starting  → "Connecting to claude.ai…" + spinner.
 *   - running   → env id + claude.ai deeplink (selectable terminal text)
 *                 + "[ enter ] Disable" button. The TopBar chip mirrors
 *                 this state so the user sees the bridge is on even
 *                 after they close the dialog.
 *   - stopping  → "Disconnecting…"
 *   - error     → red error message (auth failure, workspace untrusted,
 *                 timeout) + "[ enter ] Retry" button.
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, Match, Show, Switch, createSignal } from "solid-js"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import type { RcBridgeStatus } from "../../daemon/rc-bridge.ts"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

export type RcBridgeDialogProps = {
  orchestrator: RemoteOrchestrator
  status: Accessor<RcBridgeStatus>
}

export function RcBridgeDialog(props: RcBridgeDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  // Local "in-flight" guard so a double-enter doesn't fire the request
  // twice while the daemon is still transitioning.
  const [busy, setBusy] = createSignal(false)

  async function activate(): Promise<void> {
    if (busy()) return
    const s = props.status()
    setBusy(true)
    try {
      if (s.state === "off" || s.state === "error") {
        await props.orchestrator.startRcBridge({})
      } else if (s.state === "running") {
        await props.orchestrator.stopRcBridge()
      }
    } catch (err) {
      // The daemon already broadcast `rcBridge.changed` with state=error
      // and the message; nothing to do here beyond logging for postmortem.
      // eslint-disable-next-line no-console
      console.error("kobe: rcBridge action failed:", err)
    } finally {
      setBusy(false)
    }
  }

  useBindings(() => ({
    enabled: dialog.stack.length > 0,
    bindings: [{ key: "return", cmd: () => void activate() }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Share to claude.ai
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <text fg={theme.textMuted} wrapMode="word">
        Registers this machine as an environment claude.ai can spawn sessions onto. Sessions run locally under the
        kobed cwd, with your worktree's files. Cloud-side sessions are independent of kobe tabs — they appear in your
        claude.ai history, not here.
      </text>

      {/* State block — switches body by current bridge state. */}
      <Switch>
        <Match when={props.status().state === "off"}>
          <text fg={theme.textMuted}>Bridge is off.</text>
        </Match>
        <Match when={props.status().state === "starting"}>
          <text fg={theme.accent}>Connecting to claude.ai…</text>
        </Match>
        <Match when={props.status().state === "running"}>
          <box flexDirection="column" gap={0}>
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>Env:</text>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                {props.status().envId}
              </text>
            </box>
            <Show when={props.status().deeplink}>
              <box flexDirection="column" gap={0} paddingTop={1}>
                <text fg={theme.textMuted}>Open from another device:</text>
                <text fg={theme.accent}>{props.status().deeplink}</text>
              </box>
            </Show>
            <Show when={props.status().cwd}>
              <box flexDirection="row" gap={1} paddingTop={1}>
                <text fg={theme.textMuted}>Cwd:</text>
                <text fg={theme.text} wrapMode="none">
                  {props.status().cwd}
                </text>
              </box>
            </Show>
          </box>
        </Match>
        <Match when={props.status().state === "stopping"}>
          <text fg={theme.textMuted}>Disconnecting…</text>
        </Match>
        <Match when={props.status().state === "error"}>
          <box flexDirection="column" gap={0}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>
              Bridge failed.
            </text>
            <Show when={props.status().errorMessage}>
              <text fg={theme.textMuted} wrapMode="word">
                {props.status().errorMessage}
              </text>
            </Show>
          </box>
        </Match>
      </Switch>

      {/* Action button — label + behavior derived from current state. */}
      <Switch>
        <Match when={props.status().state === "off"}>
          <ActionButton label="[ enter ] Enable" disabled={busy()} onClick={activate} />
        </Match>
        <Match when={props.status().state === "running"}>
          <ActionButton label="[ enter ] Disable" disabled={busy()} onClick={activate} variant="warning" />
        </Match>
        <Match when={props.status().state === "error"}>
          <ActionButton label="[ enter ] Retry" disabled={busy()} onClick={activate} />
        </Match>
        <Match when={props.status().state === "starting" || props.status().state === "stopping"}>
          <ActionButton label="working…" disabled />
        </Match>
      </Switch>
    </box>
  )
}

function ActionButton(props: {
  label: string
  disabled?: boolean
  onClick?: () => void
  variant?: "warning"
}) {
  const { theme } = useTheme()
  const fg = () => {
    if (props.disabled) return theme.textMuted
    if (props.variant === "warning") return theme.warning
    return theme.accent
  }
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundElement}
      onMouseUp={() => {
        if (!props.disabled) props.onClick?.()
      }}
    >
      <text fg={fg()} attributes={TextAttributes.BOLD}>
        {props.label}
      </text>
    </box>
  )
}

RcBridgeDialog.show = (
  dialog: DialogContext,
  orchestrator: RemoteOrchestrator,
  status: Accessor<RcBridgeStatus>,
): void => {
  dialog.replace(() => <RcBridgeDialog orchestrator={orchestrator} status={status} />)
}
