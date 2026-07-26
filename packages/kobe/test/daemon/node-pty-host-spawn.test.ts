import { detachOptions } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { type NodePtyHostResolution, resolveNodePtyHostSpawn } from "@sma1lboy/kobe-daemon/client/pty-process"
import { defaultPtyHostSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import { describe, expect, test } from "vitest"

/**
 * Every case injects platform + disk. These branches only ever execute on
 * Windows, so on a POSIX CI host they would otherwise be unreachable — i.e.
 * shipped untested. The injection is the only reason this file means anything.
 */
const DIR = "/pkg/src/client"
const PACKAGED = "/pkg/src/client/pty-host-node.mjs"
const ENTRY = "/pkg/src/daemon/pty-host-node-entry.ts"
const CACHE = "/pkg/.cache/pty-host-node.mjs"
// One PATH entry keeps the fixture free of the host's path delimiter.
const PATH_DIR = "/tools/bin"
const NODE = "/tools/bin/node.EXE"
const ENV = { PATH: PATH_DIR, PATHEXT: ".EXE;.CMD" }

/**
 * `node:path` resolves with the HOST's separators, so these assertions must
 * not care whether the runner produced `/pkg/x` or `C:\pkg\x` — otherwise the
 * file is green on CI and red on a contributor's Windows box.
 */
const norm = (path: string) => path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "")

const diskWith = (...present: string[]) => {
  const set = new Set(present)
  return (path: string) => set.has(norm(path))
}

const win = (over: NodePtyHostResolution = {}): NodePtyHostResolution => ({
  platform: "win32",
  moduleDir: DIR,
  env: ENV,
  exists: diskWith(NODE),
  bundle: async () => ({ success: true, logs: [] }),
  ...over,
})

describe("resolveNodePtyHostSpawn", () => {
  test("returns null off Windows so every other platform keeps the Bun host", async () => {
    expect(await resolveNodePtyHostSpawn({ platform: "darwin", moduleDir: DIR })).toBeNull()
    expect(await resolveNodePtyHostSpawn({ platform: "linux", moduleDir: DIR })).toBeNull()
  })

  test("prefers the bundle shipped next to the cli, without invoking a bundler", async () => {
    let bundled = false
    const spawn = await resolveNodePtyHostSpawn(
      win({
        exists: diskWith(NODE, PACKAGED, ENTRY),
        bundle: async () => {
          bundled = true
          return { success: true, logs: [] }
        },
      }),
    )
    // An absolute node, not the bare name: the detached child must not depend
    // on how PATH looks by the time it starts.
    expect(norm(spawn?.[0] ?? "")).toBe(NODE)
    expect(norm(spawn?.[1] ?? "")).toBe(PACKAGED)
    expect(bundled).toBe(false)
  })

  test("builds the dev entry into the daemon package's cache when no bundle shipped", async () => {
    const seen: Array<[string, string]> = []
    const spawn = await resolveNodePtyHostSpawn(
      win({
        exists: diskWith(NODE, ENTRY),
        bundle: async (entry, outDir) => {
          seen.push([norm(entry), norm(outDir)])
          return { success: true, logs: [] }
        },
      }),
    )
    expect(norm(spawn?.[1] ?? "")).toBe(CACHE)
    // The cache MUST stay inside the daemon package: the bundle imports
    // node-pty externally, so it resolves against that package's node_modules.
    expect(seen).toEqual([[ENTRY, "/pkg/.cache"]])
  })

  test("names both candidates when neither the bundle nor the source entry exists", async () => {
    await expect(resolveNodePtyHostSpawn(win())).rejects.toThrow(/no Windows PTY host found/)
    await expect(resolveNodePtyHostSpawn(win())).rejects.toThrow(/pty-host-node-entry\.ts/)
  })

  test("surfaces bundler logs instead of returning a path to a file that was never written", async () => {
    await expect(
      resolveNodePtyHostSpawn(
        win({ exists: diskWith(NODE, ENTRY), bundle: async () => ({ success: false, logs: ["boom"] }) }),
      ),
    ).rejects.toThrow(/could not build the Windows PTY host — boom/)
  })

  test("says node is missing rather than letting the spawn fail into a 5s timeout", async () => {
    // `bun install -g @sma1lboy/kobe` never brings node along, and without
    // this the only symptom is a pty host that never answers.
    await expect(resolveNodePtyHostSpawn(win({ exists: diskWith(PACKAGED, ENTRY) }))).rejects.toThrow(
      /no node was found on PATH/,
    )
  })

  test("accepts a shim that only exists under a later PATHEXT entry", async () => {
    // Volta/fnm publish node.cmd, not node.exe.
    const shim = `${PATH_DIR}/node.CMD`
    const spawn = await resolveNodePtyHostSpawn(win({ exists: diskWith(shim, PACKAGED) }))
    expect(norm(spawn?.[0] ?? "")).toBe(shim)
  })
})

describe("defaultPtyHostSocketPath", () => {
  test("Windows gets a named pipe, since node cannot bind a filesystem socket there", () => {
    expect(defaultPtyHostSocketPath("C:\\Users\\dev", "win32")).toMatch(/^\\\\\.\\pipe\\kobe-[0-9a-f]{8}-pty$/)
  })

  test("POSIX still gets the unix socket under the home dir", () => {
    expect(norm(defaultPtyHostSocketPath("/home/dev", "linux"))).toBe("/home/dev/.kobe/pty.sock")
  })
})

describe("detachOptions", () => {
  test("POSIX detaches; Windows only hides, so no stray console window appears", () => {
    expect(detachOptions("darwin")).toEqual({ detached: true })
    expect(detachOptions("linux")).toEqual({ detached: true })
    expect(detachOptions("win32")).toEqual({ windowsHide: true })
  })
})
