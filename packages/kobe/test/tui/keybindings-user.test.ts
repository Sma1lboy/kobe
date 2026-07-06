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

const ID = "sidebar.rename"

let warnSpy: MockInstance

beforeEach(() => {
  fileState.exists = true
  fileState.doc = null
  fileState.warnings = []
  fileState.resetCalls = 0
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  userKb.reloadUserKeybindings()
  resetKeymapToDefaults()
})

afterEach(() => {
  warnSpy.mockRestore()
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

  test("tmux.* entries are routed to the tmux resolver and reported with prefix-aware hints", () => {
    fileState.doc = { bindings: { "tmux.tab.new": "ctrl+g" } }
    const report = userKb.reloadUserKeybindings()
    const applied = report.applied.find((a) => a.id === "tmux.tab.new")
    expect(applied).toBeDefined()
    expect(applied?.keys).toEqual(["ctrl+g"])
    expect(applied?.defaultKeys).toEqual(["ctrl+t"])
    const row = KobeKeymap.find((r) => r.id === "tmux.tab.new")
    if (row?.hint) expect(row.hint.keys).toBe("ctrl+g")
  })
})

describe("reloadUserKeybindings", () => {
  test("removing an override restores the default instead of the stale chord", () => {
    const defaultKeys = [...(findBinding(ID)?.keys ?? [])]
    fileState.doc = { bindings: { [ID]: "ctrl+r" } }
    userKb.reloadUserKeybindings()
    expect([...(findBinding(ID)?.keys ?? [])]).toEqual(["ctrl+r"])

    fileState.doc = null
    userKb.reloadUserKeybindings()
    expect([...(findBinding(ID)?.keys ?? [])]).toEqual(defaultKeys)
  })

  test("drops the file-read cache so the fresh file content is seen", () => {
    userKb.reloadUserKeybindings()
    expect(fileState.resetCalls).toBeGreaterThan(0)
  })
})
