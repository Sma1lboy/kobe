/**
 * Framework-free half of the settings Dev actions — shared by the Solid
 * (`./actions.ts`) and React (`src/tui-react/component/settings-dialog/
 * actions.ts`) dialogs, which each own only their confirm-dialog wiring.
 */

import { unlinkSync } from "node:fs"
import { join } from "node:path"
import { RemoteOrchestrator } from "../../../client/remote-orchestrator"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator"
import { homeDir } from "../../../env"

/** "Restart backend" is only offered when attached to a real daemon. */
export function hasRestartableDaemon(orchestrator: KobeOrchestrator | undefined): boolean {
  return orchestrator instanceof RemoteOrchestrator
}

/** Structural renderer type — both hosts only need `destroy()` here. */
export type DestroyableRenderer = { destroy(): void }

export function destroyRendererSafely(renderer: DestroyableRenderer | null | undefined, action: string): void {
  try {
    renderer?.destroy()
  } catch (err) {
    console.error(`kobe: renderer.destroy() failed during ${action}:`, err)
  }
}

/** Delete `~/.kobe/tasks.json` for the Dev "reset UI state" flow. */
export function removeTasksFileForReset(): void {
  try {
    unlinkSync(join(homeDir(), ".kobe", "tasks.json"))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("kobe: failed to delete tasks.json during reset:", err)
    }
  }
}
