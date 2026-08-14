import { delimiter } from "node:path"
import { detachOptions } from "@sma1lboy/kobe-daemon/client/daemon-process"
import {
  type NodePtyHostResolution,
  bundleWithBun,
  resolveNodeBinary,
  resolveNodePtyHostSpawn,
} from "@sma1lboy/kobe-daemon/client/pty-process"
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
        bundle: async (entry, outFile) => {
          seen.push([norm(entry), norm(outFile)])
          return { success: true, logs: [] }
        },
      }),
    )
    expect(norm(spawn?.[1] ?? "")).toBe(CACHE)
    // The bundler is asked for the exact file that gets spawned, and the cache
    // MUST stay inside the daemon package: the bundle imports node-pty
    // externally, so it resolves against that package's node_modules.
    expect(seen).toEqual([[ENTRY, CACHE]])
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
    // `bun install -g @sma1lboy/rove` never brings node along, and without
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

describe("bundleWithBun", () => {
  const io = (buildOk: boolean) => {
    const calls: string[] = []
    return {
      calls,
      io: {
        build: async (config: { outdir: string; naming: string; external: string[]; target: string }) => {
          calls.push(`build:${norm(config.outdir)}/${config.naming}`)
          calls.push(`target:${config.target}`)
          calls.push(`external:${config.external.join(",")}`)
          return { success: buildOk, logs: buildOk ? [] : ["boom"] }
        },
        rename: async (from: string, to: string) => {
          calls.push(`rename:${norm(from)}->${norm(to)}`)
        },
        discard: async (path: string) => {
          calls.push(`discard:${norm(path)}`)
        },
      },
    }
  }

  test("builds to a pid-unique sibling and renames it into place", async () => {
    const { calls, io: fake } = io(true)
    const result = await bundleWithBun("/pkg/entry.ts", CACHE, fake)

    expect(result.success).toBe(true)
    const staging = `${CACHE}.${process.pid}.tmp`
    // Never built straight to CACHE: another instance may be spawning it.
    expect(calls).toContain(`build:/pkg/.cache/${staging.split("/").pop()}`)
    expect(calls).toContain(`rename:${staging}->${CACHE}`)
    expect(calls.some((c) => c.startsWith("discard:"))).toBe(false)
  })

  test("keeps the bundle node-targeted with node-pty external", async () => {
    // Inlining node-pty's napi loader would break its resolution from the
    // installed package; a bun target would not run under node at all.
    const { calls, io: fake } = io(true)
    await bundleWithBun("/pkg/entry.ts", CACHE, fake)
    expect(calls).toContain("target:node")
    expect(calls).toContain("external:node-pty")
  })

  test("discards the partial and never renames when the build fails", async () => {
    const { calls, io: fake } = io(false)
    const result = await bundleWithBun("/pkg/entry.ts", CACHE, fake)

    expect(result.success).toBe(false)
    expect(calls).toContain(`discard:${CACHE}.${process.pid}.tmp`)
    expect(calls.some((c) => c.startsWith("rename:"))).toBe(false)
  })
})

describe("resolveNodeBinary", () => {
  test("returns null when PATH is empty or unset rather than a bare name", () => {
    // A bare "node" would defer the failure to spawn time, where it surfaces
    // only as a pty host that never answers.
    expect(resolveNodeBinary({}, diskWith(NODE), "win32")).toBeNull()
    expect(resolveNodeBinary({ PATH: "" }, diskWith(NODE), "win32")).toBeNull()
  })

  test("reads Path when PATH is absent — Windows env casing is not guaranteed", () => {
    expect(norm(resolveNodeBinary({ Path: PATH_DIR, PATHEXT: ".EXE" }, diskWith(NODE), "win32") ?? "")).toBe(NODE)
  })

  test("POSIX looks for a bare node, with no extension appended", () => {
    const posixNode = "/usr/local/bin/node"
    expect(norm(resolveNodeBinary({ PATH: "/usr/local/bin" }, diskWith(posixNode), "linux") ?? "")).toBe(posixNode)
    // …and must not invent an extension that only exists on Windows.
    expect(resolveNodeBinary({ PATH: "/usr/local/bin" }, diskWith("/usr/local/bin/node.EXE"), "linux")).toBeNull()
  })

  test("scans PATH in order and takes the first directory that has one", () => {
    const first = "/a/node.EXE"
    const second = "/b/node.EXE"
    const env = { PATH: ["/a", "/b"].join(delimiter), PATHEXT: ".EXE" }
    expect(norm(resolveNodeBinary(env, diskWith(first, second), "win32") ?? "")).toBe(first)
    expect(norm(resolveNodeBinary(env, diskWith(second), "win32") ?? "")).toBe(second)
  })

  test("falls back to a default PATHEXT when the env does not set one", () => {
    expect(norm(resolveNodeBinary({ PATH: PATH_DIR }, diskWith(NODE), "win32") ?? "")).toBe(NODE)
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
