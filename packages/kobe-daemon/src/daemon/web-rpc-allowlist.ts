import type { DaemonRequestName } from "./protocol.ts"

/**
 * The daemon RPCs the browser UI may invoke through POST /api/rpc.
 *
 * Explicit allowlist: a new daemon verb is not browser-reachable until added
 * deliberately alongside the SPA surface that uses it.
 */
export const WEB_RPC_ALLOWLIST: readonly DaemonRequestName[] = [
  "daemon.status",
  "task.list",
  "task.get",
  "task.create",
  "task.archive",
  "task.rename",
  "task.setBranch",
  "task.setVendor",
  "task.delete",
  "task.pin",
  "task.move",
  "task.status",
  "task.reorder",
  "task.ensureMain",
  "task.ensureWorktree",
  "task.setActive",
  "worktree.discoverAdoptable",
  "worktree.adopt",
]

export const WEB_RPC_ALLOWSET: ReadonlySet<string> = new Set<string>(WEB_RPC_ALLOWLIST)
