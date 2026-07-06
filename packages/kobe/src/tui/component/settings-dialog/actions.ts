import type { useRenderer } from "@opentui/solid"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator"
import type { KVContext } from "../../context/kv"
import type { DialogContext } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { destroyRendererSafely, hasRestartableDaemon, removeTasksFileForReset } from "./actions-core"

export { hasRestartableDaemon } from "./actions-core"

/**
 * Reset is "wipe + relaunch" rather than "wipe + snap defaults in
 * place": kv.clear() only resets the on-disk KV store, not the live
 * Solid signals (selectedId, pane widths, themeCtx's internal store,
 * tabsByTask, etc.) that app.tsx persists on the next signal change.
 */
export async function confirmResetState(
  dialog: DialogContext,
  kv: KVContext,
  renderer: ReturnType<typeof useRenderer> | undefined,
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

/**
 * Stop the kobe daemon and quit kobe. The next relaunch will spawn a
 * fresh daemon from disk, picking up daemon/orchestrator/engine edits.
 */
export async function confirmRestartDaemon(
  dialog: DialogContext,
  orchestrator: KobeOrchestrator | undefined,
  renderer: ReturnType<typeof useRenderer> | undefined,
): Promise<void> {
  if (!hasRestartableDaemon(orchestrator)) return
  const ok = await DialogConfirm.show(
    dialog,
    "Restart backend?",
    "Quits this kobe window. Relaunch to (re)spawn the daemon. Any other attached windows keep their connection. In v0.6 the daemon's RPC surface shrank to task CRUD + subscribe, so a graceful daemon.stop RPC is no longer plumbed through the client — quit + relaunch is the path.",
    "cancel",
  )
  if (ok !== true) return
  // v0.5's `orchestrator.stopDaemon()` is gone with the rest of the
  // chat-stream RPCs. The user can `kobe daemon stop` from a shell if
  // they want to nuke the daemon proper; here we just quit the TUI.
  destroyRendererSafely(renderer, "daemon restart")
  process.stderr.write("kobe: window closed. Relaunch kobe to start fresh.\n")
  process.exit(0)
}
