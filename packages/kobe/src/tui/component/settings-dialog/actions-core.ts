import { unlinkSync } from "node:fs"
import { join } from "node:path"
import { RemoteOrchestrator } from "../../../client/remote-orchestrator"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator"
import { homeDir } from "../../../env"

export function hasRestartableDaemon(orchestrator: KobeOrchestrator | undefined): boolean {
  return orchestrator instanceof RemoteOrchestrator
}

export type DestroyableRenderer = { destroy(): void }

export function destroyRendererSafely(renderer: DestroyableRenderer | null | undefined, action: string): void {
  try {
    renderer?.destroy()
  } catch (err) {
    console.error(`kobe: renderer.destroy() failed during ${action}:`, err)
  }
}

export function removeTasksFileForReset(): void {
  try {
    unlinkSync(join(homeDir(), ".kobe", "tasks.json"))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("kobe: failed to delete tasks.json during reset:", err)
    }
  }
}
