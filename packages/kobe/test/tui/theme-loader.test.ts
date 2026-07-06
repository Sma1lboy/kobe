import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { loadUserThemes } from "../../src/tui/context/theme/loader"

let tmpRoot: string
let prevHome: string | undefined

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-theme-loader-"))
  prevHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpRoot
})

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset when the var was unset before the test (assigning undefined leaves it as the string "undefined"). Same pattern as test/state/repos.test.ts.
  if (prevHome === undefined) delete process.env.KOBE_HOME_DIR
  else process.env.KOBE_HOME_DIR = prevHome
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
  vi.restoreAllMocks()
})

function writeTheme(name: string, body: unknown): void {
  const dir = path.join(tmpRoot, ".kobe", "themes")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body))
}

describe("loadUserThemes", () => {
  test("returns empty when the themes dir does not exist (silent — no warn)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = loadUserThemes()
    expect(out).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  test("loads valid themes by filename and skips an invalid file with a warn", () => {
    writeTheme("nyx.json", { theme: { background: "#000", text: "#fff" } })
    writeTheme("solar.json", {
      defs: { brand: "#ffaa00" },
      theme: { primary: "brand", background: { dark: "#101010", light: "#f8f8f8" } },
    })
    writeTheme("broken.json", { defs: { x: "#000" } })
    writeTheme("garbage.json", "{ not json")

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = loadUserThemes()
    const names = out.map((t) => t.name).sort()
    expect(names).toEqual(["nyx", "solar"])
    const solar = out.find((t) => t.name === "solar")
    expect(solar?.theme.defs?.brand).toBe("#ffaa00")
    expect(warn).toHaveBeenCalledTimes(2)
    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("broken.json"))).toBe(true)
    expect(messages.some((m) => m.includes("garbage.json"))).toBe(true)
  })

  test("ignores non-`.json` files in the themes dir", () => {
    const dir = path.join(tmpRoot, ".kobe", "themes")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "README.md"), "ignore me")
    fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ theme: { text: "#fff" } }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = loadUserThemes()
    expect(out.map((t) => t.name)).toEqual(["ok"])
    expect(warn).not.toHaveBeenCalled()
  })
})
