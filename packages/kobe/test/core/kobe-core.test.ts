import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const fake = vi.hoisted(() => ({
  storeHomeDirs: [] as (string | undefined)[],
  loadCalls: 0,
  disposeCalls: 0,
}))

vi.mock("../../src/orchestrator/index/store.ts", () => ({
  TaskIndexStore: class {
    constructor(opts?: { homeDir?: string }) {
      fake.storeHomeDirs.push(opts?.homeDir)
    }
    async load() {
      fake.loadCalls++
    }
  },
}))
vi.mock("../../src/orchestrator/worktree/manager.ts", () => ({ GitWorktreeManager: class {} }))
vi.mock("../../src/orchestrator/core.ts", () => ({
  Orchestrator: class {
    dispose() {
      fake.disposeCalls++
    }
  },
}))

const { createKobeCore } = await import("../../src/core/index.ts")

let prevHome: string | undefined

beforeEach(() => {
  fake.storeHomeDirs = []
  fake.loadCalls = 0
  fake.disposeCalls = 0
  prevHome = process.env.KOBE_HOME_DIR
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
})

describe("createKobeCore", () => {
  test("an explicit homeDir option wins over KOBE_HOME_DIR", async () => {
    process.env.KOBE_HOME_DIR = "/env-home"
    const core = await createKobeCore({ homeDir: "/opt-home" })
    expect(core.homeDir).toBe("/opt-home")
    expect(fake.storeHomeDirs).toEqual(["/opt-home"])
  })

  test("KOBE_HOME_DIR wins over the OS home dir", async () => {
    process.env.KOBE_HOME_DIR = "/env-home"
    const core = await createKobeCore()
    expect(core.homeDir).toBe("/env-home")
  })

  test("loads the store before returning and exposes the wired pieces", async () => {
    const core = await createKobeCore({ homeDir: "/h" })
    expect(fake.loadCalls).toBe(1)
    expect(core.store).toBeDefined()
    expect(core.worktrees).toBeDefined()
    expect(core.orchestrator).toBeDefined()
  })

  test("close() disposes the orchestrator", async () => {
    const core = await createKobeCore({ homeDir: "/h" })
    await core.close()
    expect(fake.disposeCalls).toBe(1)
  })
})
