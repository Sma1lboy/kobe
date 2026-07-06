import type { KobeOrchestrator } from "../../../client/remote-orchestrator"
import {
  type DestroyableRenderer,
  destroyRendererSafely,
  hasRestartableDaemon,
  removeTasksFileForReset,
} from "../../../tui/component/settings-dialog/actions-core"
import type { KVContext } from "../../context/kv"
import type { DialogContext } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"

export { hasRestartableDaemon } from "../../../tui/component/settings-dialog/actions-core"

export async function confirmResetState(
  dialog: DialogContext,
  kv: KVContext,
  renderer: DestroyableRenderer | null | undefined,
): Promise<void> {
  const ok = await DialogConfirm.show(
    dialog,
    "Reset UI state?",
    "Wipes ~/.config/kobe/state.json and ~/.kobe/tasks.json, then quits kobe — relaunch for a fresh start with empty Working session / Archive lists. Worktrees on disk and Claude Code session history are NOT touched.",
    "cancel",
  )
  if (ok !== true) return
  kv.clear()
  removeTasksFileForReset()
  destroyRendererSafely(renderer, "reset")
  process.stderr.write("kobe: UI state reset. Relaunch kobe to start fresh.\n")
  process.exit(0)
}

export async function confirmRestartDaemon(
  dialog: DialogContext,
  orchestrator: KobeOrchestrator | undefined,
  renderer: DestroyableRenderer | null | undefined,
): Promise<void> {
  if (!hasRestartableDaemon(orchestrator)) return
  const ok = await DialogConfirm.show(
    dialog,
    "Restart backend?",
    "Quits this kobe window. Relaunch to (re)spawn the daemon. Any other attached windows keep their connection. In v0.6 the daemon's RPC surface shrank to task CRUD + subscribe, so a graceful daemon.stop RPC is no longer plumbed through the client — quit + relaunch is the path.",
    "cancel",
  )
  if (ok !== true) return
  destroyRendererSafely(renderer, "daemon restart")
  process.stderr.write("kobe: window closed. Relaunch kobe to start fresh.\n")
  process.exit(0)
}
