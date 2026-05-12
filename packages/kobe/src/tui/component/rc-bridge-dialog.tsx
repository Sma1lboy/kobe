/**
 * "Share to claude.ai" dialog (KOB-62) — exposes the remote-control
 * bridge to the focused chat tab.
 *
 * Per-tab semantics: when the user enables share-mode while focused on
 * a kobe chat tab, the bridge spawns with `cwd = task.worktreePath` and
 * binds to the tab's `sessionId`. The dialog surfaces both so the user
 * can open the env URL on another device, pick the environment in
 * claude.ai, and `/resume <sessionId>` to continue the conversation
 * they were having locally — instead of starting an unrelated fresh
 * session in the same worktree.
 *
 * Limitation (and why this is "manual resume" not "auto-attach"):
 * Anthropic's bridge only exposes the cwd as an environment, not a
 * session-migration API. Kobe still owns its local claude subprocess;
 * the cloud worker is independent. The two share access to the
 * worktree's JSONL on disk, which is what makes `/resume <sid>` work.
 * See the KOB-62 S1 spike for the full reasoning.
 *
 * UX states:
 *   - off       → "[ enter ] Enable" — disabled when no active task to bind.
 *   - starting  → "Connecting to claude.ai…"
 *   - running   → env id, deeplink, bound task title + sessionId
 *                 + "[ enter ] Disable".
 *   - stopping  → "Disconnecting…"
 *   - error     → red error message + "[ enter ] Retry".
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, Match, Show, Switch, createSignal } from "solid-js"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import type { RcBridgeStatus } from "../../daemon/rc-bridge.ts"
import type { Task } from "../../types/task.ts"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

export type RcBridgeDialogProps = {
  orchestrator: RemoteOrchestrator
  status: Accessor<RcBridgeStatus>
  /**
   * Currently focused task (used to bind the bridge on Enable). Optional
   * because the chip in the top bar can open the dialog from contexts
   * where no task happens to be active — in that case Enable is disabled.
   */
  activeTask?: Accessor<Task | undefined>
  /**
   * Currently focused chat tab id within the active task. Defaults to
   * the task's `activeTabId` server-side if omitted (or null/undefined).
   */
  activeTabId?: Accessor<string | null | undefined>
}

type ActiveTabIdAccessor = Accessor<string | null | undefined>

export function RcBridgeDialog(props: RcBridgeDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  // Local "in-flight" guard so a double-enter doesn't fire the request
  // twice while the daemon is still transitioning.
  const [busy, setBusy] = createSignal(false)

  // What we'd bind on Enable. Only consulted when state is off / error.
  const targetTask = (): Task | undefined => props.activeTask?.()
  const canEnable = (): boolean => Boolean(targetTask())

  async function activate(): Promise<void> {
    if (busy()) return
    const s = props.status()
    setBusy(true)
    try {
      if (s.state === "off" || s.state === "error") {
        const task = targetTask()
        if (!task) return
        await props.orchestrator.startRcBridge({
          taskId: task.id,
          tabId: props.activeTabId?.() ?? undefined,
        })
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
        Binds this task's worktree to a claude.ai environment so you can pick it up from another device. claude.ai
        sessions on that environment run on your machine under the task's worktree — and if this tab already has a kobe
        conversation, you can `/resume {"<id>"}` it in claude.ai to keep going from where you left off.
      </text>

      {/* State block — switches body by current bridge state. */}
      <Switch>
        <Match when={props.status().state === "off"}>
          <Show
            when={canEnable()}
            fallback={
              <text fg={theme.textMuted}>
                No active task — select a task in the sidebar first, then re-open this dialog.
              </text>
            }
          >
            <box flexDirection="column" gap={0}>
              <text fg={theme.textMuted}>Will share:</text>
              <box flexDirection="row" gap={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  {targetTask()?.title ?? ""}
                </text>
                <text fg={theme.textMuted}>·</text>
                <text fg={theme.text} wrapMode="none">
                  {targetTask()?.worktreePath ?? ""}
                </text>
              </box>
            </box>
          </Show>
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
            <Show when={props.status().bound}>
              <box flexDirection="column" gap={0} paddingTop={1}>
                <box flexDirection="row" gap={1}>
                  <text fg={theme.textMuted}>Sharing:</text>
                  <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
                    {props.status().bound?.taskTitle ?? props.status().bound?.taskId}
                  </text>
                </box>
                <Show
                  when={props.status().bound?.sessionId}
                  fallback={
                    <text fg={theme.textMuted} wrapMode="word">
                      (no kobe session yet — claude.ai will start a fresh one in this worktree)
                    </text>
                  }
                >
                  <box flexDirection="column" gap={0}>
                    <text fg={theme.textMuted}>To continue this tab's conversation in claude.ai, run:</text>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      /resume {props.status().bound?.sessionId}
                    </text>
                  </box>
                </Show>
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
          <ActionButton label="[ enter ] Enable" disabled={busy() || !canEnable()} onClick={activate} />
        </Match>
        <Match when={props.status().state === "running"}>
          <ActionButton label="[ enter ] Disable" disabled={busy()} onClick={activate} variant="warning" />
        </Match>
        <Match when={props.status().state === "error"}>
          <ActionButton label="[ enter ] Retry" disabled={busy() || !canEnable()} onClick={activate} />
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
  activeTask?: Accessor<Task | undefined>,
  activeTabId?: ActiveTabIdAccessor,
): void => {
  dialog.replace(() => (
    <RcBridgeDialog orchestrator={orchestrator} status={status} activeTask={activeTask} activeTabId={activeTabId} />
  ))
}
