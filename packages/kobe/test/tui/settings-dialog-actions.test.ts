/**
 * settings-dialog/actions.ts — the reset-state / restart-daemon confirm
 * flows. DialogConfirm (the opentui overlay) is mocked to a canned answer;
 * what's pinned is the DESTRUCTIVE sequencing: nothing happens on cancel,
 * and on confirm the KV wipe + tasks.json unlink + renderer teardown +
 * exit(0) all fire in that order. `hasRestartableDaemon` gates on the
 * concrete RemoteOrchestrator class.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const fake = vi.hoisted(() => ({
  confirmAnswer: true as boolean | undefined,
  unlinkCalls: [] as string[],
  unlinkError: null as (Error & { code?: string }) | null,
}))

vi.mock("../../src/tui/ui/dialog-confirm", () => ({
  DialogConfirm: { show: vi.fn(async () => fake.confirmAnswer) },
}))
vi.mock("../../src/env", () => ({ homeDir: () => "/home/user" }))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    unlinkSync: (p: string) => {
      fake.unlinkCalls.push(p)
      if (fake.unlinkError) throw fake.unlinkError
    },
  }
})
// RemoteOrchestrator only needs to be a constructible class for instanceof.
vi.mock("../../src/client/remote-orchestrator", () => {
  class RemoteOrchestrator {}
  return { RemoteOrchestrator }
})

const actions = await import("../../src/tui/component/settings-dialog/actions")
const { RemoteOrchestrator } = await import("../../src/client/remote-orchestrator")
const { DialogConfirm } = await import("../../src/tui/ui/dialog-confirm")

type Dialog = Parameters<typeof actions.confirmResetState>[0]
type KV = Parameters<typeof actions.confirmResetState>[1]
type Renderer = Parameters<typeof actions.confirmResetState>[2]

const dialog = {} as Dialog

function makeKv() {
  return { clear: vi.fn() } as unknown as KV
}

function makeRenderer() {
  const destroy = vi.fn()
  return { renderer: { destroy } as unknown as Renderer, destroy }
}

let exitSpy: ReturnType<typeof vi.fn>
let stderrSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fake.confirmAnswer = true
  fake.unlinkCalls = []
  fake.unlinkError = null
  exitSpy = vi.fn(() => {
    throw new Error("exit sentinel")
  })
  vi.spyOn(process, "exit").mockImplementation(exitSpy as unknown as typeof process.exit)
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("hasRestartableDaemon", () => {
  test("true only for a RemoteOrchestrator instance", () => {
    // biome-ignore lint/suspicious/noExplicitAny: constructing the mocked class
    expect(actions.hasRestartableDaemon(new (RemoteOrchestrator as any)())).toBe(true)
    expect(actions.hasRestartableDaemon(undefined)).toBe(false)
    expect(actions.hasRestartableDaemon({} as Parameters<typeof actions.hasRestartableDaemon>[0])).toBe(false)
  })
})

describe("confirmResetState", () => {
  test("cancel leaves everything untouched", async () => {
    fake.confirmAnswer = undefined // esc / cancel
    const kv = makeKv()
    await actions.confirmResetState(dialog, kv, undefined)
    expect(kv.clear).not.toHaveBeenCalled()
    expect(fake.unlinkCalls).toEqual([])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("confirm wipes KV + tasks.json, destroys the renderer, and exits 0", async () => {
    const kv = makeKv()
    const { renderer, destroy } = makeRenderer()
    await expect(actions.confirmResetState(dialog, kv, renderer)).rejects.toThrow("exit sentinel")
    expect(kv.clear).toHaveBeenCalledTimes(1)
    expect(fake.unlinkCalls).toEqual(["/home/user/.kobe/tasks.json"])
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  test("a missing tasks.json (ENOENT) is fine; other unlink errors are logged, reset continues", async () => {
    fake.unlinkError = Object.assign(new Error("EACCES"), { code: "EACCES" })
    const kv = makeKv()
    await expect(actions.confirmResetState(dialog, kv, undefined)).rejects.toThrow("exit sentinel")
    expect(console.error).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  test("a throwing renderer.destroy never blocks the reset", async () => {
    const kv = makeKv()
    const renderer = { destroy: () => {
      throw new Error("renderer boom")
    } } as unknown as Renderer
    await expect(actions.confirmResetState(dialog, kv, renderer)).rejects.toThrow("exit sentinel")
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})

describe("confirmRestartDaemon", () => {
  test("no-ops entirely for a non-remote orchestrator", async () => {
    await actions.confirmRestartDaemon(dialog, undefined, undefined)
    expect(DialogConfirm.show).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("cancel keeps the window alive", async () => {
    fake.confirmAnswer = false
    // biome-ignore lint/suspicious/noExplicitAny: constructing the mocked class
    await actions.confirmRestartDaemon(dialog, new (RemoteOrchestrator as any)(), undefined)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("confirm destroys the renderer and exits 0", async () => {
    const { renderer, destroy } = makeRenderer()
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: constructing the mocked class
      actions.confirmRestartDaemon(dialog, new (RemoteOrchestrator as any)(), renderer),
    ).rejects.toThrow("exit sentinel")
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
