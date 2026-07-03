/**
 * Platform routing for `openExternally` (filetree `o` key). node:os /
 * node:fs / node:child_process are mocked so each OS branch is asserted
 * by WHICH opener binary gets spawned with what args — including the WSL
 * wslview → explorer.exe fallback chain.
 */

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const fake = vi.hoisted(() => ({
  platform: "darwin" as string,
  wslInteropFile: false,
  spawnCalls: [] as Array<{ cmd: string; args: string[] }>,
  /** Command names whose spawn should immediately emit "error" (binary missing). */
  failing: new Set<string>(),
  /** stdout text for the wslpath -w child. */
  wslpathOut: "C:\\Users\\me\\file.pdf",
}))

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  unref = vi.fn()
}

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, platform: () => fake.platform }
})
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, existsSync: (p: string) => (p.includes("WSLInterop") ? fake.wslInteropFile : false) }
})
vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    fake.spawnCalls.push({ cmd, args })
    const child = new FakeChild()
    queueMicrotask(() => {
      if (fake.failing.has(cmd)) {
        child.emit("error", new Error(`spawn ${cmd} ENOENT`))
        return
      }
      if (cmd === "wslpath") {
        child.stdout.emit("data", Buffer.from(fake.wslpathOut))
        child.emit("close", 0)
      }
    })
    return child
  }),
}))

const { openExternally } = await import("../../src/tui/panes/filetree/open-external")

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

beforeEach(() => {
  fake.platform = "darwin"
  fake.wslInteropFile = false
  fake.spawnCalls = []
  fake.failing = new Set()
  Reflect.deleteProperty(process.env, "WSL_DISTRO_NAME")
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("openExternally", () => {
  test("an empty path spawns nothing", async () => {
    openExternally("")
    await flush()
    expect(fake.spawnCalls).toEqual([])
  })

  test("macOS uses `open`", async () => {
    openExternally("/wt/a.pdf")
    await flush()
    expect(fake.spawnCalls).toEqual([{ cmd: "open", args: ["/wt/a.pdf"] }])
  })

  test("plain Linux uses xdg-open", async () => {
    fake.platform = "linux"
    openExternally("/wt/a.pdf")
    await flush()
    expect(fake.spawnCalls).toEqual([{ cmd: "xdg-open", args: ["/wt/a.pdf"] }])
  })

  test("Windows native routes through cmd.exe start", async () => {
    fake.platform = "win32"
    openExternally("C:/a.pdf")
    await flush()
    expect(fake.spawnCalls).toEqual([{ cmd: "cmd.exe", args: ["/c", "start", "", "C:/a.pdf"] }])
  })

  test("WSL prefers wslview when it launches", async () => {
    fake.platform = "linux"
    process.env.WSL_DISTRO_NAME = "Ubuntu"
    openExternally("/wt/a.pdf")
    await flush()
    expect(fake.spawnCalls).toEqual([{ cmd: "wslview", args: ["/wt/a.pdf"] }])
  })

  test("WSL without wslview converts via wslpath and opens explorer.exe", async () => {
    fake.platform = "linux"
    fake.wslInteropFile = true
    fake.failing = new Set(["wslview"])
    openExternally("/wt/a.pdf")
    await flush()
    expect(fake.spawnCalls.map((c) => c.cmd)).toEqual(["wslview", "wslpath", "explorer.exe"])
    expect(fake.spawnCalls[2]?.args).toEqual(["C:\\Users\\me\\file.pdf"])
  })

  test("an unknown platform is a silent no-op", async () => {
    fake.platform = "freebsd"
    openExternally("/wt/a.pdf")
    await flush()
    expect(fake.spawnCalls).toEqual([])
  })
})
