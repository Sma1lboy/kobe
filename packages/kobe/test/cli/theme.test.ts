import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runThemeSubcommand } from "../../src/cli/theme.ts"

const VALID_THEME = {
  defs: { bg: "#000000", fg: "#ffffff" },
  theme: {
    background: "bg",
    foreground: "fg",
  },
}

let home: string
let originalHome: string | undefined
let outSpy: MockInstance<typeof process.stdout.write>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>

function themesDir(): string {
  return join(home, ".kobe", "themes")
}

beforeEach(() => {
  originalHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-theme-"))
  process.env.KOBE_HOME_DIR = home

  outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
  outSpy.mockRestore()
  errSpy.mockRestore()
  exitSpy.mockRestore()
  vi.unstubAllGlobals()
})

function out(): string {
  return outSpy.mock.calls.map((c) => String(c[0])).join("")
}
function err(): string {
  return errSpy.mock.calls.map((c) => String(c[0])).join("")
}

describe("runThemeSubcommand — usage / dispatch", () => {
  it("no action prints usage and exits 2", async () => {
    await expect(runThemeSubcommand([])).rejects.toThrow("exit 2")
    expect(err()).toContain("Usage: kobe theme")
  })

  it("--help prints usage without exiting", async () => {
    await runThemeSubcommand(["--help"])
    expect(err()).toContain("Usage: kobe theme")
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("unknown action fails usage with exit 2", async () => {
    await expect(runThemeSubcommand(["bogus"])).rejects.toThrow("exit 2")
    expect(err()).toContain('unknown action "bogus"')
  })
})

describe("runThemeSubcommand list", () => {
  it("lists bundled themes and '(none)' when no user themes exist", async () => {
    await runThemeSubcommand(["list"])
    const text = out()
    expect(text).toContain("bundled:")
    expect(text).toContain("claude  [built-in]")
    expect(text).toContain("(none)")
  })

  it("lists a user theme, flagging one that overrides a bundled name", async () => {
    const dir = themesDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "my-theme.json"), "{}", "utf8")
    writeFileSync(join(dir, "claude.json"), "{}", "utf8")
    await runThemeSubcommand(["list"])
    const text = out()
    expect(text).toContain("my-theme")
    expect(text).toContain("claude (overrides built-in)")
  })

  it("rejects extra arguments to list", async () => {
    await expect(runThemeSubcommand(["list", "extra"])).rejects.toThrow("exit 2")
    expect(err()).toContain('"list" takes no arguments')
  })

  it("ls is an alias for list", async () => {
    await runThemeSubcommand(["ls"])
    expect(out()).toContain("bundled:")
  })
})

describe("runThemeSubcommand add (local path)", () => {
  it("installs a valid theme from a local file, defaulting the name to the basename", async () => {
    const src = join(home, "mytheme.json")
    writeFileSync(src, JSON.stringify(VALID_THEME), "utf8")
    await runThemeSubcommand(["add", src])
    const dest = join(themesDir(), "mytheme.json")
    expect(JSON.parse(readFileSync(dest, "utf8"))).toEqual(VALID_THEME)
    expect(out()).toContain(`installed theme "mytheme" -> ${dest}`)
  })

  it("--name overrides the default name", async () => {
    const src = join(home, "src.json")
    writeFileSync(src, JSON.stringify(VALID_THEME), "utf8")
    await runThemeSubcommand(["add", src, "--name", "custom"])
    expect(readFileSync(join(themesDir(), "custom.json"), "utf8")).toContain('"bg"')
  })

  it("refuses to overwrite an existing theme without --force", async () => {
    const src = join(home, "src.json")
    writeFileSync(src, JSON.stringify(VALID_THEME), "utf8")
    await runThemeSubcommand(["add", src, "--name", "dup"])
    await expect(runThemeSubcommand(["add", src, "--name", "dup"])).rejects.toThrow("exit 1")
    expect(err()).toContain("already exists (pass --force to overwrite)")
  })

  it("--force overwrites an existing theme", async () => {
    const src = join(home, "src.json")
    writeFileSync(src, JSON.stringify(VALID_THEME), "utf8")
    await runThemeSubcommand(["add", src, "--name", "dup"])
    await runThemeSubcommand(["add", src, "--name", "dup", "--force"])
    expect(out()).toContain('installed theme "dup"')
  })

  it("fails with exit 1 on invalid JSON", async () => {
    const src = join(home, "bad.json")
    writeFileSync(src, "{not json", "utf8")
    await expect(runThemeSubcommand(["add", src])).rejects.toThrow("exit 1")
    expect(err()).toContain("not valid JSON")
  })

  it("fails with exit 1 on a schema-invalid theme", async () => {
    const src = join(home, "invalid.json")
    writeFileSync(src, JSON.stringify({ nope: true }), "utf8")
    await expect(runThemeSubcommand(["add", src])).rejects.toThrow("exit 1")
    expect(err()).toContain("not a valid kobe theme")
  })

  it("fails when the source file cannot be read", async () => {
    await expect(runThemeSubcommand(["add", join(home, "missing.json")])).rejects.toThrow("exit 1")
    expect(err()).toContain("failed to read")
  })

  it("rejects an invalid theme name", async () => {
    const src = join(home, "src.json")
    writeFileSync(src, JSON.stringify(VALID_THEME), "utf8")
    await expect(runThemeSubcommand(["add", src, "--name", "bad name!"])).rejects.toThrow("exit 1")
    expect(err()).toContain("invalid theme name")
  })

  it("missing <source> fails usage with exit 2", async () => {
    await expect(runThemeSubcommand(["add"])).rejects.toThrow("exit 2")
    expect(err()).toContain("missing <source>")
  })

  it("rejects an unknown flag and an unexpected extra positional", async () => {
    await expect(runThemeSubcommand(["add", "x", "--bogus"])).rejects.toThrow("exit 2")
    expect(err()).toContain("unknown flag: --bogus")

    errSpy.mockClear()
    await expect(runThemeSubcommand(["add", "x", "y"])).rejects.toThrow("exit 2")
    expect(err()).toContain("unexpected positional argument: y")
  })
})

describe("runThemeSubcommand add (URL source)", () => {
  it("fetches, validates, and installs from an http(s) URL, naming from the URL basename", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(VALID_THEME)),
    })
    vi.stubGlobal("fetch", fetchMock)
    await runThemeSubcommand(["add", "https://example.com/themes/cool.json?token=abc"])
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/themes/cool.json?token=abc")
    expect(readFileSync(join(themesDir(), "cool.json"), "utf8")).toContain('"bg"')
  })

  it("fails with exit 1 on a non-OK HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }))
    await expect(runThemeSubcommand(["add", "https://example.com/x.json"])).rejects.toThrow("exit 1")
    expect(err()).toContain("HTTP 404 Not Found")
  })

  it("fails with exit 1 when fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
    await expect(runThemeSubcommand(["add", "https://example.com/x.json"])).rejects.toThrow("exit 1")
    expect(err()).toContain("failed to fetch")
    expect(err()).toContain("network down")
  })
})

describe("runThemeSubcommand remove", () => {
  it("removes a user theme", async () => {
    mkdirSync(themesDir(), { recursive: true })
    writeFileSync(join(themesDir(), "gone.json"), "{}", "utf8")
    await runThemeSubcommand(["remove", "gone"])
    expect(out()).toContain('removed theme "gone"')
    expect(() => readFileSync(join(themesDir(), "gone.json"), "utf8")).toThrow()
  })

  it("rm is an alias for remove", async () => {
    mkdirSync(themesDir(), { recursive: true })
    writeFileSync(join(themesDir(), "gone.json"), "{}", "utf8")
    await runThemeSubcommand(["rm", "gone"])
    expect(out()).toContain('removed theme "gone"')
  })

  it("refuses to remove a bundled theme name", async () => {
    await expect(runThemeSubcommand(["remove", "claude"])).rejects.toThrow("exit 1")
    expect(err()).toContain("is a built-in theme and cannot be removed")
  })

  it("fails when no such user theme exists", async () => {
    await expect(runThemeSubcommand(["remove", "nope"])).rejects.toThrow("exit 1")
    expect(err()).toContain('no user theme named "nope"')
  })

  it("missing <name> fails usage with exit 2", async () => {
    await expect(runThemeSubcommand(["remove"])).rejects.toThrow("exit 2")
    expect(err()).toContain("missing <name>")
  })

  it("rejects unexpected extra arguments", async () => {
    await expect(runThemeSubcommand(["remove", "a", "b"])).rejects.toThrow("exit 2")
    expect(err()).toContain('unexpected extra arguments after "a"')
  })
})
