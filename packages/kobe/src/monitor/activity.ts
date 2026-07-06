import { engineEntry } from "@/engine/registry"
import type { VendorId } from "@/types/task"

export async function latestTranscriptMtime(vendor: VendorId, worktree: string): Promise<number> {
  if (!worktree) return 0
  return engineEntry(vendor).history.latestTranscriptMtimeForWorktree(worktree)
}
