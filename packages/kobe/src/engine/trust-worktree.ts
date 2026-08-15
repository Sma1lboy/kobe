/**
 * Worktree pre-trust at spawn time (issue #28). A Rove-created worktree is
 * a directory the engine has never seen, and every vendor gates that behind
 * a first-run trust dialog a hosted session cannot answer — kimi's dialog
 * even EXITS the process when the pasted first message's Enter lands on
 * "Don't trust"; claude/codex sit at the prompt forever. The vendor-specific
 * store writes live behind the registry's `trustWorktree` hook; THIS wrapper
 * owns the call policy every spawn path shares: best-effort, never blocks a
 * launch (a failed write leaves the pre-#28 status quo — the dialog).
 */

import type { VendorId } from "../types/vendor.ts"
import { engineEntry } from "./registry.ts"

export function trustEngineWorktree(vendor: VendorId | undefined, worktreePath: string): void {
  try {
    engineEntry(vendor ?? "claude").trustWorktree?.(worktreePath)
  } catch {
    /* best-effort — see the module doc */
  }
}
