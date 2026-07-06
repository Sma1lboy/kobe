import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("../../src/tui/context/theme", () => ({
  FOCUS_ACCENT_SLOTS: ["primary", "success", "info"] as const,
  hasTheme: (name: string) => ["claude", "tokyonight"].includes(name),
}))

const { readPersistedUiPrefs } = await import("../../src/tui/lib/persisted-ui-prefs.ts")

let home: string
let prevHome: string | undefined

function writeState(content: string): void {
  const dir = join(home, ".config", "kobe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "state.json"), content)
}

beforeEach(() => {
  prevHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-uiprefs-"))
  process.env.KOBE_HOME_DIR = home
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  rmSync(home, { recursive: true, force: true })
})

describe("readPersistedUiPrefs", () => {
  test("reads valid persisted prefs", () => {
    writeState(
      JSON.stringify({
        activeTheme: "tokyonight",
        transparentBackground: true,
        focusAccent: "success",
        locale: "en",
      }),
    )
    expect(readPersistedUiPrefs("claude")).toEqual({
      theme: "tokyonight",
      transparent: true,
      focusAccent: "success",
      locale: "en",
    })
  })

  test("a stale/unknown theme name falls back to the caller's fallback", () => {
    writeState(JSON.stringify({ activeTheme: "deleted-user-theme" }))
    expect(readPersistedUiPrefs("claude").theme).toBe("claude")
  })

  test("each field validates independently — garbage in one doesn't poison the others", () => {
    writeState(
      JSON.stringify({
        activeTheme: "claude",
        transparentBackground: "yes",
        focusAccent: "not-a-slot",
        locale: "xx-nope",
      }),
    )
    const prefs = readPersistedUiPrefs("claude")
    expect(prefs.theme).toBe("claude")
    expect(prefs.transparent).toBe(false)
    expect(prefs.focusAccent).toBeNull()
    expect(prefs.locale).toBe("en")
  })

  test("missing or corrupt state.json yields full defaults, never throws", () => {
    expect(readPersistedUiPrefs("claude")).toEqual({
      theme: "claude",
      transparent: false,
      focusAccent: null,
      locale: "en",
    })
    writeState("{corrupt")
    expect(readPersistedUiPrefs("claude").theme).toBe("claude")
  })
})
