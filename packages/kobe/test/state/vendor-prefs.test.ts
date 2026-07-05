/**
 * Vendor-preference layering: per-repo last-active → global default →
 * legacy `lastSelectedVendor` → claude, with each layer validated
 * independently (a corrupt repo entry must fall through to the global
 * default, not straight to the built-in fallback). Isolated state.json
 * via `KOBE_HOME_DIR`.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { setPersistedString } from "../../src/state/repos.ts"
import {
  getGlobalDefaultVendor,
  getRepoLastActiveVendor,
  resolvePreferredVendor,
  setGlobalDefaultVendor,
  setRepoLastActiveVendor,
} from "../../src/state/vendor-prefs.ts"

let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-vendor-prefs-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe("vendor preference layers", () => {
  test("unset everywhere → claude", () => {
    expect(resolvePreferredVendor("/repo")).toBe("claude")
    expect(resolvePreferredVendor()).toBe("claude")
    expect(getGlobalDefaultVendor()).toBeUndefined()
  })

  test("repo last-active wins over the global default", () => {
    setGlobalDefaultVendor("claude")
    setRepoLastActiveVendor("/repo", "codex")
    expect(resolvePreferredVendor("/repo")).toBe("codex")
    expect(resolvePreferredVendor("/other")).toBe("claude")
    expect(resolvePreferredVendor()).toBe("claude")
  })

  test("legacy lastSelectedVendor backs the global default until defaultVendor is set", () => {
    setPersistedString("lastSelectedVendor", "codex")
    expect(getGlobalDefaultVendor()).toBe("codex")
    expect(resolvePreferredVendor("/repo")).toBe("codex")
    setGlobalDefaultVendor("copilot")
    expect(getGlobalDefaultVendor()).toBe("copilot")
  })

  test("a corrupt repo entry falls through to the global default", () => {
    setPersistedString("lastActiveVendor./repo", "gpt9-typo")
    setGlobalDefaultVendor("codex")
    expect(getRepoLastActiveVendor("/repo")).toBeUndefined()
    expect(resolvePreferredVendor("/repo")).toBe("codex")
  })
})
