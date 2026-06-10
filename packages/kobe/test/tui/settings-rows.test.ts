/**
 * Settings dialog row registry (settings-dialog/model.ts).
 *
 * Why these tests matter: the dialog's keyboard nav (j/k/enter), the
 * engines-section row-gated keys (r/x/d), and every section view's
 * cursor highlight all key off "a row's body index is its position in
 * the section's row list". Before the registry this was hand-chained
 * offset arithmetic (transparentRowIndex = themeCount, toastRowIndex =
 * themeCount+1+accentCount, ...) where one insertion shifted every
 * downstream index. These tests pin (a) the exact on-screen row ORDER
 * per section, (b) count parity with the old offset formulas for
 * representative input sizes, and (c) the id-lookup helpers the views
 * use instead of arithmetic. If a row is added or reordered, the order
 * test here is the single place that must change with it.
 */

import { describe, expect, it } from "vitest"
import {
  SECTIONS,
  type SettingsRowsInput,
  bodyRowCount,
  devRows,
  engineRowId,
  engineRows,
  feedbackRows,
  focusAccentRowId,
  generalRows,
  rowAt,
  rowIndex,
  sectionRows,
  surfaceRowId,
  themeRowId,
} from "../../src/tui/component/settings-dialog/model.ts"
import type { FocusAccentSlot } from "../../src/tui/context/theme.tsx"
import { ALL_VENDORS } from "../../src/types/vendor.ts"

const SLOTS: readonly FocusAccentSlot[] = ["primary", "success", "info"]

function input(overrides: Partial<SettingsRowsInput> = {}): SettingsRowsInput {
  return {
    themeNames: ["claude", "gruvbox", "tokyonight"],
    focusAccentSlots: SLOTS,
    engineList: [...ALL_VENDORS],
    hasDaemon: true,
    ...overrides,
  }
}

describe("generalRows", () => {
  it("lays out themes, transparent, accents, toast, sound, surfaces, editor pair — in that order", () => {
    const themes = ["a", "b", "c"]
    const rows = generalRows({ themeNames: themes, focusAccentSlots: SLOTS })
    expect(rows.map((r) => r.kind)).toEqual([
      "theme",
      "theme",
      "theme",
      "transparent",
      "focusAccent",
      "focusAccent",
      "focusAccent",
      "toast",
      "sound",
      "surface",
      "surface",
      "editorKind",
      "editorCustom",
    ])
    // Payload order matches input order, and the two surfaces are ChatTab then Task panel.
    expect(rows.slice(0, 3).map((r) => (r.kind === "theme" ? r.name : "?"))).toEqual(themes)
    expect(rows.slice(4, 7).map((r) => (r.kind === "focusAccent" ? r.slot : "?"))).toEqual([...SLOTS])
    expect(rows.filter((r) => r.kind === "surface").map((r) => r.surface)).toEqual(["chattab", "taskpanel"])
  })

  it("matches the old offset formula (themeCount + 1 + accentCount + 6) for representative sizes", () => {
    for (const themeCount of [0, 1, 12, 30]) {
      const themes = Array.from({ length: themeCount }, (_, i) => `theme-${i}`)
      const rows = generalRows({ themeNames: themes, focusAccentSlots: SLOTS })
      expect(rows.length).toBe(themeCount + 1 + SLOTS.length + 6)
      // Old transparentRowIndex(themeCount) === themeCount.
      expect(rowIndex(rows, "transparent")).toBe(themeCount)
      // Old toastRowIndex / soundRowIndex chain.
      expect(rowIndex(rows, "toast")).toBe(themeCount + 1 + SLOTS.length)
      expect(rowIndex(rows, "sound")).toBe(themeCount + 1 + SLOTS.length + 1)
      expect(rowIndex(rows, surfaceRowId("chattab"))).toBe(themeCount + 1 + SLOTS.length + 2)
      expect(rowIndex(rows, surfaceRowId("taskpanel"))).toBe(themeCount + 1 + SLOTS.length + 3)
      expect(rowIndex(rows, "editor-kind")).toBe(themeCount + 1 + SLOTS.length + 4)
      expect(rowIndex(rows, "editor-custom")).toBe(themeCount + 1 + SLOTS.length + 5)
    }
  })

  it("indexes a focus-accent slot by id (old focusAccentRowIndex = themeCount + 1 + slot position)", () => {
    const themes = ["a", "b"]
    const rows = generalRows({ themeNames: themes, focusAccentSlots: SLOTS })
    SLOTS.forEach((slot, i) => {
      expect(rowIndex(rows, focusAccentRowId(slot))).toBe(themes.length + 1 + i)
    })
  })
})

describe("engineRows", () => {
  it("is one row per engine plus the trailing add row (old engineRowCount = vendors + custom + 1)", () => {
    const customs = ["aider", "goose"]
    const list = [...ALL_VENDORS, ...customs]
    const rows = engineRows(list)
    expect(rows.length).toBe(ALL_VENDORS.length + customs.length + 1)
    // Engine row index === its position in the engine list (the section's <For> order).
    list.forEach((vendor, i) => {
      expect(rowIndex(rows, engineRowId(vendor))).toBe(i)
      const row = rowAt(rows, i)
      expect(row?.kind === "engine" && row.vendor).toBe(vendor)
    })
    // The add row sits last, at index === engine count (old addRowIndex).
    const last = rowAt(rows, list.length)
    expect(last?.kind).toBe("engineAdd")
  })

  it("with zero custom engines still ends with the add row", () => {
    const rows = engineRows(ALL_VENDORS)
    expect(rows.length).toBe(ALL_VENDORS.length + 1)
    expect(rows.at(-1)?.kind).toBe("engineAdd")
  })
})

describe("devRows", () => {
  it("with a daemon: reset, restart, remote-projects (old devRowCount(true) === 3)", () => {
    const rows = devRows(true)
    expect(rows.map((r) => r.kind)).toEqual(["devReset", "devRestartDaemon", "devRemoteProjects"])
    // Old experimentalRemoteRowIndex(true) === 2.
    expect(rowIndex(rows, "remote-projects")).toBe(2)
  })

  it("without a daemon: reset, remote-projects (old devRowCount(false) === 2)", () => {
    const rows = devRows(false)
    expect(rows.map((r) => r.kind)).toEqual(["devReset", "devRemoteProjects"])
    // Old experimentalRemoteRowIndex(false) === 1.
    expect(rowIndex(rows, "remote-projects")).toBe(1)
  })
})

describe("feedbackRows", () => {
  it("is title, body, send (old feedbackRowCount === 3)", () => {
    expect(feedbackRows().map((r) => r.kind)).toEqual(["feedbackTitle", "feedbackBody", "feedbackSend"])
  })
})

describe("sectionRows / bodyRowCount", () => {
  it("accounts and keys are read-only — zero navigable rows", () => {
    expect(sectionRows("accounts", input())).toEqual([])
    expect(sectionRows("keys", input())).toEqual([])
  })

  it("bodyRowCount is the registry length for every section", () => {
    const inp = input({ engineList: [...ALL_VENDORS, "aider"], hasDaemon: false })
    for (const { id } of SECTIONS) {
      expect(bodyRowCount(id, inp)).toBe(sectionRows(id, inp).length)
    }
  })

  it("matches the old per-section count formulas for a representative input", () => {
    // 12 themes, 3 accents, 2 custom engines, daemon attached.
    const themes = Array.from({ length: 12 }, (_, i) => `t${i}`)
    const inp = input({ themeNames: themes, engineList: [...ALL_VENDORS, "aider", "goose"], hasDaemon: true })
    expect(bodyRowCount("general", inp)).toBe(12 + 1 + 3 + 6) // 22
    expect(bodyRowCount("engines", inp)).toBe(ALL_VENDORS.length + 2 + 1) // 6
    expect(bodyRowCount("accounts", inp)).toBe(0)
    expect(bodyRowCount("keys", inp)).toBe(0)
    expect(bodyRowCount("feedback", inp)).toBe(3)
    expect(bodyRowCount("dev", inp)).toBe(3)
    expect(bodyRowCount("dev", { ...inp, hasDaemon: false })).toBe(2)
  })

  it("row ids are unique within every section", () => {
    const inp = input({ engineList: [...ALL_VENDORS, "aider"] })
    for (const { id } of SECTIONS) {
      const ids = sectionRows(id, inp).map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

describe("rowIndex / rowAt", () => {
  it("returns -1 / undefined for unknown id or out-of-range index", () => {
    const rows = generalRows({ themeNames: ["a"], focusAccentSlots: SLOTS })
    expect(rowIndex(rows, "no-such-row")).toBe(-1)
    expect(rowAt(rows, -1)).toBeUndefined()
    expect(rowAt(rows, rows.length)).toBeUndefined()
  })

  it("looks a theme row up by id", () => {
    const rows = generalRows({ themeNames: ["claude", "gruvbox"], focusAccentSlots: SLOTS })
    expect(rowIndex(rows, themeRowId("gruvbox"))).toBe(1)
  })
})
