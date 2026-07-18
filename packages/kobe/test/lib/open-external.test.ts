/**
 * Why: `systemOpenArgv` is the one per-platform branch in the system-viewer
 * hand-off (ops preview `o` on an image/binary card). Locking the argv per
 * platform keeps a refactor from silently breaking the two platforms the
 * author isn't developing on.
 */

import { describe, expect, test } from "vitest"
import { systemOpenArgv } from "../../src/lib/open-external.ts"

describe("systemOpenArgv", () => {
  test("darwin uses open", () => {
    expect(systemOpenArgv("/tmp/a.png", "darwin")).toEqual(["open", "/tmp/a.png"])
  })

  test("linux (and anything else) uses xdg-open", () => {
    expect(systemOpenArgv("/tmp/a.png", "linux")).toEqual(["xdg-open", "/tmp/a.png"])
    expect(systemOpenArgv("/tmp/a.png", "freebsd")).toEqual(["xdg-open", "/tmp/a.png"])
  })

  test("win32 uses cmd start with the empty title slot", () => {
    expect(systemOpenArgv("C:\\a b.png", "win32")).toEqual(["cmd", "/c", "start", "", "C:\\a b.png"])
  })
})
