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
  humanizeSlug,
  rowAt,
  rowIndex,
  sectionRows,
  splitStyleRowId,
  themeRowId,
} from "../../src/tui/component/settings-dialog/model.ts"
import type { FocusAccentSlot } from "../../src/tui/context/theme-core.ts"
import { LOCALES } from "../../src/tui/i18n/catalog.ts"
import { ALL_VENDORS } from "../../src/types/vendor.ts"

const SLOTS: readonly FocusAccentSlot[] = ["primary", "success", "info"]
/** Language picker rows sit right after the theme list — count them in the offsets. */
const LANG = LOCALES.length

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
  it("lays out themes, languages, visual preferences, notifications, and editor rows in order", () => {
    const themes = ["a", "b", "c"]
    const rows = generalRows({ themeNames: themes, focusAccentSlots: SLOTS })
    expect(rows.map((r) => r.kind)).toEqual([
      "theme",
      "theme",
      "theme",
      ...LOCALES.map(() => "language" as const),
      "transparent",
      "focusAccent",
      "focusAccent",
      "focusAccent",
      "reducedMotion",
      "splitStyle",
      "splitStyle",
      "toast",
      "sound",
      "crossTask",
      "zenKeepTasks",
      "editorKind",
      "editorCustom",
      "worktreeBase",
      "worktreeCustom",
      "scrollbackRows",
    ])
    // Payload order matches input order.
    expect(rows.slice(0, 3).map((r) => (r.kind === "theme" ? r.name : "?"))).toEqual(themes)
    expect(rows.filter((r) => r.kind === "language").map((r) => r.locale)).toEqual(LOCALES.map((l) => l.id))
    expect(
      rows.slice(3 + LANG + 1, 3 + LANG + 1 + SLOTS.length).map((r) => (r.kind === "focusAccent" ? r.slot : "?")),
    ).toEqual([...SLOTS])
  })

  it("matches the offset formula for representative sizes", () => {
    for (const themeCount of [0, 1, 12, 30]) {
      const themes = Array.from({ length: themeCount }, (_, i) => `theme-${i}`)
      const rows = generalRows({ themeNames: themes, focusAccentSlots: SLOTS })
      expect(rows.length).toBe(themeCount + LANG + 1 + SLOTS.length + 12)
      // transparent sits after the theme list + the language picker.
      expect(rowIndex(rows, "transparent")).toBe(themeCount + LANG)
      // reduced-motion after the accents, then the split-style pair,
      // toast/sound/cross-task, the zen toggle, then editors.
      expect(rowIndex(rows, "reduced-motion")).toBe(themeCount + LANG + 1 + SLOTS.length)
      expect(rowIndex(rows, splitStyleRowId("box"))).toBe(themeCount + LANG + 1 + SLOTS.length + 1)
      expect(rowIndex(rows, splitStyleRowId("line"))).toBe(themeCount + LANG + 1 + SLOTS.length + 2)
      expect(rowIndex(rows, "toast")).toBe(themeCount + LANG + 1 + SLOTS.length + 3)
      expect(rowIndex(rows, "sound")).toBe(themeCount + LANG + 1 + SLOTS.length + 4)
      expect(rowIndex(rows, "cross-task")).toBe(themeCount + LANG + 1 + SLOTS.length + 5)
      expect(rowIndex(rows, "zen-keep-tasks")).toBe(themeCount + LANG + 1 + SLOTS.length + 6)
      expect(rowIndex(rows, "editor-kind")).toBe(themeCount + LANG + 1 + SLOTS.length + 7)
      expect(rowIndex(rows, "editor-custom")).toBe(themeCount + LANG + 1 + SLOTS.length + 8)
    }
  })

  it("indexes a focus-accent slot by id (focusAccentRowIndex = themeCount + langCount + 1 + slot position)", () => {
    const themes = ["a", "b"]
    const rows = generalRows({ themeNames: themes, focusAccentSlots: SLOTS })
    SLOTS.forEach((slot, i) => {
      expect(rowIndex(rows, focusAccentRowId(slot))).toBe(themes.length + LANG + 1 + i)
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
  it("with a daemon: reset, restart, remote-projects, auto-status, dispatcher, archived-history", () => {
    const rows = devRows(true)
    expect(rows.map((r) => r.kind)).toEqual([
      "devReset",
      "devRestartDaemon",
      "devRemoteProjects",
      "devAutoStatus",
      "devDispatcher",
      "devArchivedHistory",
    ])
    expect(rowIndex(rows, "remote-projects")).toBe(2)
    expect(rowIndex(rows, "auto-status")).toBe(3)
    expect(rowIndex(rows, "dispatcher")).toBe(4)
    expect(rowIndex(rows, "archived-history")).toBe(5)
  })

  it("without a daemon: reset, remote-projects, auto-status, dispatcher, archived-history", () => {
    const rows = devRows(false)
    expect(rows.map((r) => r.kind)).toEqual([
      "devReset",
      "devRemoteProjects",
      "devAutoStatus",
      "devDispatcher",
      "devArchivedHistory",
    ])
    expect(rowIndex(rows, "remote-projects")).toBe(1)
    expect(rowIndex(rows, "auto-status")).toBe(2)
    expect(rowIndex(rows, "dispatcher")).toBe(3)
    expect(rowIndex(rows, "archived-history")).toBe(4)
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
    expect(bodyRowCount("general", inp)).toBe(12 + LANG + 1 + 3 + 12) // themes + langs + transparent + accents + retained general rows
    expect(bodyRowCount("engines", inp)).toBe(ALL_VENDORS.length + 2 + 1) // 6
    expect(bodyRowCount("accounts", inp)).toBe(0)
    expect(bodyRowCount("keys", inp)).toBe(0)
    expect(bodyRowCount("feedback", inp)).toBe(3)
    expect(bodyRowCount("dev", inp)).toBe(6)
    expect(bodyRowCount("dev", { ...inp, hasDaemon: false })).toBe(5)
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

describe("humanizeSlug", () => {
  it("title-cases hyphen/underscore-separated words", () => {
    expect(humanizeSlug("my-local-agent")).toBe("My Local Agent")
    expect(humanizeSlug("my_local_agent")).toBe("My Local Agent")
    expect(humanizeSlug("aider")).toBe("Aider")
  })

  it("drops empty segments from doubled/leading separators", () => {
    expect(humanizeSlug("--weird--slug-")).toBe("Weird Slug")
    expect(humanizeSlug("")).toBe("")
  })
})
