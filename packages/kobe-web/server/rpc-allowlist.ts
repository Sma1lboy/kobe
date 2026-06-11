import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"

/**
 * The daemon RPCs the web UI may invoke through POST /api/rpc — an explicit
 * ALLOWLIST, not a denylist. The bridge's RPC route used to forward anything
 * except hello/subscribe/daemon.stop, which meant every future daemon verb
 * (including destructive or hook-ingest ones) was auto-exposed to any page
 * that could reach the port. Now a verb must be added here deliberately,
 * alongside the SPA surface that uses it.
 *
 * Excluded on purpose:
 *  - `hello` / `subscribe` — connection-scoped, owned by the bridge's own
 *    DaemonLink; a browser re-subscribing would corrupt the link state.
 *  - `daemon.stop` — the browser must not be able to kill the daemon.
 *  - `engine.reportEvent` / `worktree.reconcile` — hook-ingest paths, only
 *    meaningful from a `kobe hook` process with a real engine cwd.
 *
 * Leaf module (type-only import) so tests can assert the contract without
 * pulling in node-only deps.
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
  "task.ensureMain",
  "task.ensureWorktree",
  "task.setActive",
  "worktree.discoverAdoptable",
  "worktree.adopt",
]

/** Membership test for the /api/rpc gate. */
export const WEB_RPC_ALLOWSET: ReadonlySet<string> = new Set<string>(WEB_RPC_ALLOWLIST)
