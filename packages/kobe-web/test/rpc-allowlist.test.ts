import { describe, expect, it } from "vitest"
import { WEB_RPC_ALLOWLIST, WEB_RPC_ALLOWSET } from "../server/rpc-allowlist.ts"

/**
 * POST /api/rpc forwards ONLY allowlisted daemon verbs. This test pins the
 * security contract: connection-scoped verbs, the daemon kill switch, and
 * the hook-ingest paths must never be browser-reachable, and a new daemon
 * verb is NOT web-exposed until someone adds it here deliberately.
 */

// Verbs that must never cross the web boundary, whatever the daemon grows.
const FORBIDDEN = [
  "hello",
  "subscribe",
  "daemon.stop",
  "engine.reportEvent",
  "worktree.reconcile",
] as const

// The mutation surface the SPA actually uses (ToolsPanel, NewTaskDialog,
// TaskRail) — kept here so removing one from the allowlist fails loudly.
const REQUIRED = [
  "task.list",
  "task.get",
  "task.create",
  "task.archive",
  "task.rename",
  "task.setBranch",
  "task.setVendor",
  "task.delete",
  "task.pin",
  "task.status",
  "task.reorder",
  "task.ensureWorktree",
  "task.setActive",
] as const

describe("WEB_RPC_ALLOWLIST", () => {
  it("never exposes connection/lifecycle/hook verbs", () => {
    for (const name of FORBIDDEN) {
      expect(WEB_RPC_ALLOWSET.has(name)).toBe(false)
    }
  })

  it("covers every verb the SPA invokes", () => {
    for (const name of REQUIRED) {
      expect(WEB_RPC_ALLOWSET.has(name)).toBe(true)
    }
  })

  it("set matches the list exactly (no duplicates)", () => {
    expect(WEB_RPC_ALLOWSET.size).toBe(WEB_RPC_ALLOWLIST.length)
    for (const name of WEB_RPC_ALLOWLIST) {
      expect(WEB_RPC_ALLOWSET.has(name)).toBe(true)
    }
  })
})
