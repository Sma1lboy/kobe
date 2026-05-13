import { unlinkSync } from "node:fs"
import { join } from "node:path"
import type { useRenderer } from "@opentui/solid"
import { RemoteOrchestrator } from "../../../client/remote-orchestrator"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator"
import { homeDir } from "../../../env"
import type { KVContext } from "../../context/kv"
import type { DialogContext } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"

export function hasRestartableDaemon(orchestrator: KobeOrchestrator | undefined): boolean {
  return orchestrator instanceof RemoteOrchestrator
}

function destroyRenderer(renderer: ReturnType<typeof useRenderer> | undefined, action: string): void {
  try {
    renderer?.destroy()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`kobe: renderer.destroy() failed during ${action}:`, err)
  }
}

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
  try {
    unlinkSync(join(homeDir(), ".kobe", "tasks.json"))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.error("kobe: failed to delete tasks.json during reset:", err)
    }
  }
  destroyRenderer(renderer, "reset")
  process.stderr.write("kobe: UI state reset. Relaunch kobe to start fresh.\n")
  process.exit(0)
}

/**
 * Stop the kobed daemon and quit kobe. The next relaunch will spawn a
 * fresh daemon from disk, picking up daemon/orchestrator/engine edits.
 */
export async function confirmRestartDaemon(
  dialog: DialogContext,
  orchestrator: KobeOrchestrator | undefined,
  renderer: ReturnType<typeof useRenderer> | undefined,
): Promise<void> {
  if (!(orchestrator instanceof RemoteOrchestrator)) return
  const ok = await DialogConfirm.show(
    dialog,
    "Restart backend?",
    "Stops the kobed daemon and quits this kobe window. Relaunch to spawn a fresh daemon with the latest code. Other attached kobe windows will lose their daemon connection too.",
    "cancel",
  )
  if (ok !== true) return
  try {
    await orchestrator.stopDaemon()
  } catch (err) {
    // daemon.stop closes the socket as part of its work; the request
    // may reject before the response frame arrives. That's the success
    // path for this destructive restart flow, so keep it logged only.
    // eslint-disable-next-line no-console
    console.error("kobe: daemon.stop returned:", err)
  }
  destroyRenderer(renderer, "daemon restart")
  process.stderr.write("kobe: daemon stopped. Relaunch kobe to start fresh.\n")
  process.exit(0)
}
