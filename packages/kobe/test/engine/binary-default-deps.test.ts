/**
 * Coverage for the REAL `defaultDeps` of the binary-discovery modules
 * (`claude-code-local/binary.ts`, `codex-local/binary.ts`,
 * `copilot-local/binary.ts`).
 *
 * `binary-discovery.test.ts` pins the search-order algorithm through the
 * injectable seam; these tests pin the default wiring that the seam hides —
 * the `which` output parsing (incl. macOS "aliased to" lines), the
 * statSync-based existence probe, env/home resolution, and the nvm-dir
 * scan. That wiring is what actually runs on every real spawn, so a typo
 * there ships even with the algorithm suite fully green. The host FS/PATH
 * must not leak in (dev machines have these binaries installed!), so
 * node:child_process, node:os and node:fs are stubbed with a virtual file
 * set — the modules under test only touch fs through the three calls
 * defaultDeps makes.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

// A REAL (empty) temp dir: `claude`'s nvm scan lists it via a module-internal
// `require("node:fs")` that vi.mock can't intercept, so directory listings
// must exist on the real disk. File-existence stays virtual (statSync below).
const HOME = mkdtempSync(path.join(tmpdir(), "kobe-bin-home-"))
/** Virtual FS: paths that exist as regular files. */
const files = new Set<string>()
/** Next `which`/`where` result. */
let which: { status: number; stdout: string } = { status: 1, stdout: "" }

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => HOME, default: { ...actual, homedir: () => HOME } }
})

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawnSync: () => ({ status: which.status, stdout: which.stdout }) }
})

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const enoent = (p: string) => {
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
    err.code = "ENOENT"
    throw err
  }
  const virtual = {
    statSync: (p: string) => (files.has(p) ? { isFile: () => true } : enoent(p)),
    existsSync: (p: string) => files.has(p),
  }
  return { ...actual, ...virtual, default: { ...actual, ...virtual } }
})

import { ClaudeBinaryNotFoundError, findClaudeBinary } from "../../src/engine/claude-code-local/binary.ts"
import { CodexBinaryNotFoundError, findCodexBinary } from "../../src/engine/codex-local/binary.ts"
import {
  CopilotBinaryNotFoundError,
  type BinaryDiscoveryDeps as CopilotDeps,
  findCopilotBinary,
} from "../../src/engine/copilot-local/binary.ts"

beforeEach(() => {
  files.clear()
  which = { status: 1, stdout: "" }
  Reflect.deleteProperty(process.env, "NVM_BIN")
})

describe("findClaudeBinary — default deps", () => {
  it("resolves a macOS `which` alias line to its target when the target exists", async () => {
    which = { status: 0, stdout: "claude: aliased to /vhome/u/real-claude\n" }
    files.add("/vhome/u/real-claude")
    await expect(findClaudeBinary()).resolves.toBe("/vhome/u/real-claude")
  })

  it("discards an alias whose target is gone and falls through to ~/.claude/local", async () => {
    which = { status: 0, stdout: "claude: aliased to /vanished/claude\n" }
    files.add(path.join(HOME, ".claude", "local", "claude"))
    await expect(findClaudeBinary()).resolves.toBe(path.join(HOME, ".claude", "local", "claude"))
  })

  it("treats blank which output as a miss and honours $NVM_BIN", async () => {
    which = { status: 0, stdout: "\n\n" }
    process.env.NVM_BIN = "/vnvm/active/bin"
    files.add("/vnvm/active/bin/claude")
    await expect(findClaudeBinary()).resolves.toBe("/vnvm/active/bin/claude")
  })

  it("scans real ~/.nvm/versions/node entries newest-first via the default readdir", async () => {
    const nvmRoot = path.join(HOME, ".nvm", "versions", "node")
    const { mkdirSync } = await vi.importActual<typeof import("node:fs")>("node:fs")
    mkdirSync(path.join(nvmRoot, "v18.0.0"), { recursive: true })
    mkdirSync(path.join(nvmRoot, "v20.1.0"), { recursive: true })
    files.add(path.join(nvmRoot, "v20.1.0", "bin", "claude"))
    await expect(findClaudeBinary()).resolves.toBe(path.join(nvmRoot, "v20.1.0", "bin", "claude"))
  })

  it("throws ClaudeBinaryNotFoundError listing every checked path when nothing exists", async () => {
    const err = await findClaudeBinary().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClaudeBinaryNotFoundError)
    const notFound = err as ClaudeBinaryNotFoundError
    expect(notFound.checkedPaths).toContain(path.join(HOME, ".claude", "local", "claude"))
    expect(notFound.checkedPaths).toContain("/opt/homebrew/bin/claude")
    expect(notFound.message).toContain("~/.claude/local/claude")
  })
})

describe("findCodexBinary — default deps", () => {
  it("resolves a `which` alias line to its target when the target exists", async () => {
    which = { status: 0, stdout: "codex: aliased to /vhome/u/real-codex\n" }
    files.add("/vhome/u/real-codex")
    await expect(findCodexBinary()).resolves.toBe("/vhome/u/real-codex")
  })

  it("ignores a which hit that is not a regular file and falls to the system paths", async () => {
    which = { status: 0, stdout: "/somewhere/codex\n" } // not in the virtual file set
    files.add("/usr/local/bin/codex")
    await expect(findCodexBinary()).resolves.toBe("/usr/local/bin/codex")
  })

  it("honours $NVM_BIN, then the per-user dirs", async () => {
    process.env.NVM_BIN = "/vnvm/bin"
    files.add("/vnvm/bin/codex")
    await expect(findCodexBinary()).resolves.toBe("/vnvm/bin/codex")

    files.clear()
    files.add(path.join(HOME, ".bun/bin/codex"))
    await expect(findCodexBinary()).resolves.toBe(path.join(HOME, ".bun/bin/codex"))
  })

  it("throws CodexBinaryNotFoundError with the checked paths when nothing exists", async () => {
    const err = await findCodexBinary().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CodexBinaryNotFoundError)
    expect((err as CodexBinaryNotFoundError).checkedPaths).toContain("/opt/homebrew/bin/codex")
  })
})

describe("findCopilotBinary — default deps", () => {
  it("resolves a `which` alias line to its target when the target exists", async () => {
    which = { status: 0, stdout: "copilot: aliased to /vhome/u/real-copilot\n" }
    files.add("/vhome/u/real-copilot")
    await expect(findCopilotBinary()).resolves.toBe("/vhome/u/real-copilot")
  })

  it("falls through a failed which to the system dirs via the default platform()", async () => {
    files.add("/opt/homebrew/bin/copilot")
    await expect(findCopilotBinary()).resolves.toBe("/opt/homebrew/bin/copilot")
  })
})

describe("findCopilotBinary — win32 npm dirs (injected deps)", () => {
  function winDeps(existing: string, env: Record<string, string> = {}): CopilotDeps {
    return {
      fileExists: (p) => p === existing,
      env: (n) => env[n],
      home: () => "C:/Users/u",
      which: () => undefined,
      platform: () => "win32",
    }
  }

  it("prefers %LOCALAPPDATA%/npm and probes the .exe/.cmd spellings", async () => {
    const hit = path.join("C:/local/npm", "copilot.cmd")
    const d = winDeps(hit, { APPDATA: "C:/roaming", LOCALAPPDATA: "C:/local" })
    await expect(findCopilotBinary(d)).resolves.toBe(hit)
  })

  it("falls back to %APPDATA%/npm, then the home AppData npm dir", async () => {
    const appData = path.join("C:/roaming/npm", "copilot.exe")
    await expect(findCopilotBinary(winDeps(appData, { APPDATA: "C:/roaming" }))).resolves.toBe(appData)

    const homeNpm = path.join("C:/Users/u", "AppData/Roaming/npm", "copilot.exe")
    await expect(findCopilotBinary(winDeps(homeNpm))).resolves.toBe(homeNpm)
  })

  it("reports every checked path (all three win32 spellings) on a miss", async () => {
    const err = await findCopilotBinary(winDeps("/nope")).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CopilotBinaryNotFoundError)
    const checked = (err as CopilotBinaryNotFoundError).checkedPaths
    expect(checked).toContain(path.join("C:/Users/u", "AppData/Roaming/npm", "copilot.exe"))
    expect(checked).toContain(path.join("C:/Users/u", "AppData/Roaming/npm", "copilot.cmd"))
    expect(checked).toContain(path.join("C:/Users/u", "AppData/Roaming/npm", "copilot"))
  })
})
