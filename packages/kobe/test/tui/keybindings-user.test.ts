/**
 * Behavioral tests for the user-keybindings loader
 * (`src/tui/context/keybindings-user.ts`): the once-per-process apply, the
 * caching, PureTUI keymap application, and reload-from-clean-slate
 * path. The file READER (`state/keybindings-file.ts`) is mocked — it needs
 * `Bun.YAML`, unavailable under vitest's node VM, and its parse behavior
 * isn't what this module owns. What IS asserted: the parsed doc lands as
 * real chord mutations on `KobeKeymap` and as an accurate applied/warnings
 * report, and a reload restores defaults for removed overrides.
 */

import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const fileState = vi.hoisted(() => ({
  exists: true,
  doc: null as unknown,
  warnings: [] as string[],
  resetCalls: 0,
}))

vi.mock("../../src/state/keybindings-file", () => ({
  readKeybindingsFile: vi.fn(() => ({
    path: "/home/user/.kobe/settings/keybindings.yaml",
    exists: fileState.exists,
    doc: fileState.doc,
    warnings: fileState.warnings,
  })),
  resetKeybindingsFileCache: vi.fn(() => {
    fileState.resetCalls++
  }),
}))

const { KobeKeymap, findBinding, resetKeymapToDefaults } = await import("../../src/tui/context/keybindings")
const userKb = await import("../../src/tui/context/keybindings-user")

const ID = "sidebar.rename" // overridable, default ["r"], carries a hint

let warnSpy: MockInstance

beforeEach(() => {
  fileState.exists = true
  fileState.doc = null
  fileState.warnings = []
  fileState.resetCalls = 0
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  // Each test starts from pristine defaults + an empty loader cache.
  userKb.reloadUserKeybindings()
  resetKeymapToDefaults()
})

afterEach(() => {
  warnSpy.mockRestore()
  // Leave the shared keymap pristine for sibling test files.
  fileState.doc = null
  userKb.reloadUserKeybindings()
  resetKeymapToDefaults()
  vi.clearAllMocks()
})

describe("applyUserKeybindings", () => {
  test("a missing file is the normal fresh-install case: empty report, no warnings", () => {
    fileState.exists = false
    userKb.reloadUserKeybindings()
    const report = userKb.userKeybindingsReport()
    expect(report).toMatchObject({ exists: false, applied: [], warnings: [] })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test("applies a bindings override onto KobeKeymap and reports it", () => {
    fileState.doc = { bindings: { [ID]: "ctrl+r" } }
    const report = userKb.reloadUserKeybindings()
    expect([...(findBinding(ID)?.keys ?? [])]).toEqual(["ctrl+r"])
    expect(report.applied).toEqual(expect.arrayContaining([expect.objectContaining({ id: ID, keys: ["ctrl+r"] })]))
    expect(report.warnings).toEqual([])
  })

  test("adds a direct chord alongside a prefix row through bindings", () => {
    fileState.doc = { bindings: { "chat.fork.new": "ctrl+g" } }
    const report = userKb.reloadUserKeybindings()

    expect(findBinding("chat.fork.new")?.keys).toEqual(["ctrl+g"])
    expect(findBinding("chat.fork.new")?.prefixKeys).toEqual(["f"])
    expect(report.warnings).toEqual([])
  })

  test("adds a prefix chord alongside a direct row through legacy prefix.bindings", () => {
    fileState.doc = { prefix: { bindings: { "sidebar.projectFilter": "p" } } }
    const report = userKb.reloadUserKeybindings()

    expect(findBinding("sidebar.projectFilter")?.keys).toEqual(["ctrl+p"])
    expect(findBinding("sidebar.projectFilter")?.prefixKeys).toEqual(["p"])
    expect(report.warnings).toEqual([])
  })

  test("adds direct positional pane navigation with four ordered chords", () => {
    fileState.doc = { bindings: { "focus.numeric": ["ctrl+g", "ctrl+h", "ctrl+i", "ctrl+j"] } }
    const report = userKb.reloadUserKeybindings()

    expect(findBinding("focus.numeric")?.keys).toEqual(["ctrl+g", "ctrl+h", "ctrl+i", "ctrl+j"])
    expect(findBinding("focus.numeric")?.prefixKeys).toEqual(["h", "j", "k", "l"])
    expect(report.warnings).toEqual([])
  })

  test("keeps both aliases when direct and prefix configuration name one id", () => {
    fileState.doc = { bindings: { "chat.tab.new": "ctrl+g" }, prefix: { bindings: { "chat.tab.new": "n" } } }
    const report = userKb.reloadUserKeybindings()

    expect(findBinding("chat.tab.new")?.keys).toEqual(["ctrl+g"])
    expect(findBinding("chat.tab.new")?.prefixKeys).toEqual(["n"])
    expect(report.warnings).toEqual([])
  })

  test("reads direct and prefix aliases from one binding object", () => {
    fileState.doc = { bindings: { "chat.tab.new": { direct: "ctrl+g", prefix: "n" } } }
    const report = userKb.reloadUserKeybindings()

    expect(findBinding("chat.tab.new")?.keys).toEqual(["ctrl+g"])
    expect(findBinding("chat.tab.new")?.prefixKeys).toEqual(["n"])
    expect(report.warnings).toEqual([])
  })

  test("warns when a configured prefix collides with a direct override", () => {
    fileState.doc = { prefix: { key: "ctrl+r" }, bindings: { [ID]: "ctrl+r" } }
    const report = userKb.reloadUserKeybindings()

    expect(report.warnings.join("\n")).toContain('prefix.key "ctrl+r" collides with direct binding sidebar.rename')
  })

  test("an unknown binding id becomes a warning, mirrored to console.warn", () => {
    fileState.doc = { bindings: { "sidebar.does-not-exist": "ctrl+x" } }
    const report = userKb.reloadUserKeybindings()
    expect(report.applied).toEqual([])
    expect(report.warnings.length).toBeGreaterThan(0)
    expect(warnSpy).toHaveBeenCalled()
  })

  test("reader warnings are folded into the report", () => {
    fileState.doc = null
    fileState.warnings = ["could not parse line 3"]
    const report = userKb.reloadUserKeybindings()
    expect(report.warnings).toContain("could not parse line 3")
  })

  test("the report is cached — a second call does not re-read the file", async () => {
    const { readKeybindingsFile } = await import("../../src/state/keybindings-file")
    fileState.doc = { bindings: { [ID]: "ctrl+r" } }
    userKb.reloadUserKeybindings()
    vi.mocked(readKeybindingsFile).mockClear()
    userKb.applyUserKeybindings()
    userKb.userKeybindingsReport()
    expect(readKeybindingsFile).not.toHaveBeenCalled()
  })
})

describe("reloadUserKeybindings", () => {
  test("removing an override restores the default instead of the stale chord", () => {
    const defaultKeys = [...(findBinding(ID)?.keys ?? [])]
    fileState.doc = { bindings: { [ID]: "ctrl+r" } }
    userKb.reloadUserKeybindings()
    expect([...(findBinding(ID)?.keys ?? [])]).toEqual(["ctrl+r"])

    fileState.doc = null // the user deleted the override
    userKb.reloadUserKeybindings()
    expect([...(findBinding(ID)?.keys ?? [])]).toEqual(defaultKeys)
  })

  test("drops the file-read cache so the fresh file content is seen", () => {
    userKb.reloadUserKeybindings()
    expect(fileState.resetCalls).toBeGreaterThan(0)
  })
})
