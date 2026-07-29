import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readSettings, setting } from "../src/settings.ts"

describe("readSettings", () => {
  it("parses KEY=value lines, skipping comments and garbage", () => {
    const dir = mkdtempSync(join(tmpdir(), "kobe-sdk-"))
    writeFileSync(join(dir, ".env"), "# comment\nMODE=fancy\nFPS=24\nnot a line\nEMPTY=\n")
    expect(readSettings(dir)).toEqual({ MODE: "fancy", FPS: "24", EMPTY: "" })
    expect(setting(dir, "MODE")).toBe("fancy")
    expect(setting(dir, "MISSING", "fallback")).toBe("fallback")
  })

  it("returns {} when the .env does not exist", () => {
    expect(readSettings("/nonexistent-dir-kobe-sdk")).toEqual({})
  })
})
