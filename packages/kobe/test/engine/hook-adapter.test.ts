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
