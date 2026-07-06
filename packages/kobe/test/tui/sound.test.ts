import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

let pathDir: string
let prevPath: string | undefined

type FakeBun = {
  file: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
}

function fakeBun(overrides: Partial<FakeBun> = {}): FakeBun {
  const bun: FakeBun = {
    file: vi.fn((p: string) => ({ exists: async () => true, path: p })),
    write: vi.fn(async () => {}),
    spawn: vi.fn(() => ({ unref: vi.fn() })),
    ...overrides,
  }
  ;(globalThis as { Bun?: unknown }).Bun = bun
  return bun
}

async function freshPulse(): Promise<(volume?: number) => void> {
  vi.resetModules()
  const mod = await import("../../src/tui/lib/sound")
  return mod.pulse
}

const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  pathDir = mkdtempSync(join(tmpdir(), "kobe-sound-path-"))
  prevPath = process.env.PATH
})

afterEach(() => {
  process.env.PATH = prevPath
  ;(globalThis as { Bun?: unknown }).Bun = undefined
  rmSync(pathDir, { recursive: true, force: true })
})

describe("pulse", () => {
  test("spawns the player found on PATH with the sound file (afplay: bare argv)", async () => {
    writeFileSync(join(pathDir, "afplay"), "#!/bin/sh\n")
    process.env.PATH = pathDir
    const bun = fakeBun()
    const pulse = await freshPulse()

    pulse()
    await settle()

    expect(bun.spawn).toHaveBeenCalledTimes(1)
    const [argv, opts] = bun.spawn.mock.calls[0] as [string[], Record<string, string>]
    expect(argv[0]).toBe("afplay")
    expect(argv[1]).toMatch(/kobe-sfx.*pulse\.wav$/)
    expect(opts).toMatchObject({ stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  })

  test("maps volume per player family (ffplay takes a filter-graph float)", async () => {
    writeFileSync(join(pathDir, "ffplay"), "#!/bin/sh\n")
    process.env.PATH = pathDir
    const bun = fakeBun()
    const pulse = await freshPulse()

    pulse(0.7)
    await settle()

    const [argv] = bun.spawn.mock.calls[0] as [string[]]
    expect(argv).toEqual(["ffplay", "-autoexit", "-nodisp", "-af", "volume=0.7", expect.stringMatching(/pulse\.wav$/)])
  })

  test("prefers the first PLAYERS entry present when several are installed", async () => {
    writeFileSync(join(pathDir, "afplay"), "")
    writeFileSync(join(pathDir, "ffplay"), "")
    process.env.PATH = pathDir
    const bun = fakeBun()
    const pulse = await freshPulse()

    pulse()
    await settle()

    expect((bun.spawn.mock.calls[0] as [string[]])[0][0]).toBe("ffplay")
  })

  test("no player on PATH → silent no-op (terminal BEL is the fallback)", async () => {
    process.env.PATH = pathDir
    const bun = fakeBun()
    const pulse = await freshPulse()

    pulse()
    await settle()

    expect(bun.spawn).not.toHaveBeenCalled()
  })

  test("a spawn failure is swallowed — pulse never throws", async () => {
    writeFileSync(join(pathDir, "afplay"), "")
    process.env.PATH = pathDir
    fakeBun({
      spawn: vi.fn(() => {
        throw new Error("spawn failed")
      }),
    })
    const pulse = await freshPulse()

    expect(() => pulse()).not.toThrow()
    await settle()
  })

  test("detaches the player so its lifetime never pins kobe at shutdown", async () => {
    writeFileSync(join(pathDir, "afplay"), "")
    process.env.PATH = pathDir
    const unref = vi.fn()
    const bun = fakeBun({ spawn: vi.fn(() => ({ unref })) })
    const pulse = await freshPulse()

    pulse()
    await settle()

    expect(bun.spawn).toHaveBeenCalledTimes(1)
    expect(unref).toHaveBeenCalledTimes(1)
  })
})
