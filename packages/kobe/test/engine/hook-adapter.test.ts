/**
 * Unit tests for `src/engine/hook-adapter.ts` — the neutral engine-hook seam.
 *
 * Why these matter: `createEngineHookAdapter` is the one place the
 * orchestrator resolves a vendor to its hook installer, and NoopHookAdapter
 * is the contract-completeness backstop for engines without wired hooks
 * (Copilot, custom engines). If the noop half ever starts claiming hook
 * support (or throws), every launch path that probes `supportsHooks()`
 * before installing would start writing into a config file that doesn't
 * exist for that engine.
 */

import { describe, expect, it } from "vitest"
import { NoopHookAdapter, createEngineHookAdapter } from "../../src/engine/hook-adapter.ts"

describe("createEngineHookAdapter", () => {
  it("resolves claude + codex to real hook adapters", () => {
    expect(createEngineHookAdapter("claude").supportsHooks()).toBe(true)
    expect(createEngineHookAdapter("codex").supportsHooks()).toBe(true)
  })

  it("resolves copilot (unwired hooks) to a noop adapter carrying the vendor id", () => {
    const adapter = createEngineHookAdapter("copilot")
    expect(adapter.supportsHooks()).toBe(false)
    expect(adapter.vendor).toBe("copilot")
  })
})

describe("NoopHookAdapter", () => {
  const noop = new NoopHookAdapter("copilot")

  it("claims no hook support and no settings file", () => {
    expect(noop.supportsHooks()).toBe(false)
    expect(noop.globalSettingsPath()).toBe("")
    expect(noop.supportsWorktreeSync()).toBe(false)
  })

  it("understands no payload — kobe hook's adapter probe must skip it", () => {
    expect(noop.activityDetailFromPayload()).toBeUndefined()
  })

  it("every install/remove is a resolved no-op (never throws into the launch path)", async () => {
    await expect(noop.installActivityHooks()).resolves.toBeUndefined()
    await expect(noop.removeActivityHooks()).resolves.toBeUndefined()
    await expect(noop.removeWorktreeSyncHook()).resolves.toBeUndefined()
    await expect(noop.installWorktreeWatchHook()).resolves.toBeUndefined()
    await expect(noop.removeWorktreeWatchHook()).resolves.toBeUndefined()
  })
})
