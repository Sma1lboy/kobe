/**
 * Unit tests for the user-theme disk loader.
 *
 * The loader runs at boot, before the ThemeProvider mounts. The bar
 * is "never crash kobe": a corrupt JSON or a schema-mismatched theme
 * file must not propagate; instead the loader emits a `console.warn`
 * (so a power user piping kobe through `2>` can find it) and continues.
 *
 * We use `KOBE_HOME_DIR` to point the loader at a tmpdir so the tests
 * never touch the developer's real `~/.kobe/`.
 */

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
  // env.ts: kobeStateDir() = join(KOBE_HOME_DIR ?? homedir(), ".kobe").
  // Point at the tmp root so the loader looks under tmpRoot/.kobe/themes/.
  process.env.KOBE_HOME_DIR = tmpRoot
})

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset when the var was unset before the test (assigning undefined leaves it as the string "undefined"). Same pattern as test/state/repos.test.ts.
  if (prevHome === undefined) delete process.env.KOBE_HOME_DIR
  else process.env.KOBE_HOME_DIR = prevHome
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
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
    // Schema-invalid: missing `theme` key.
    writeTheme("broken.json", { defs: { x: "#000" } })
    // Non-JSON: ensures the JSON.parse failure path also `console.warn`s
    // and skips rather than throws.
    writeTheme("garbage.json", "{ not json")

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = loadUserThemes()
    const names = out.map((t) => t.name).sort()
    expect(names).toEqual(["nyx", "solar"])
    // Confirm the structure round-trips: solar's `defs` survives.
    const solar = out.find((t) => t.name === "solar")
    expect(solar?.theme.defs?.brand).toBe("#ffaa00")
    expect(warn).toHaveBeenCalledTimes(2) // one for broken.json, one for garbage.json
    // Both warn calls should mention the file's basename so users can
    // find the offending file.
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
