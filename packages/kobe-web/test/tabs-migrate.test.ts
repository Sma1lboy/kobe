import { describe, expect, it } from "vitest"
import { migrateStoredTab } from "../src/lib/tabs.ts"

/**
 * Stale localStorage from older builds can carry retired tab kinds. The
 * migration must coerce them to current kinds so the SPA never renders an
 * unknown tab (or crashes) on load.
 */

describe("migrateStoredTab", () => {
  it("migrates the retired 'notes' kind to an empty chooser tab", () => {
    const out = migrateStoredTab({ id: "x", kind: "notes", title: "Notes" })
    expect(out.kind).toBe("empty")
    expect(out.id).toBeTruthy()
  })

  it("renames the legacy 'chat' kind to 'vendor'", () => {
    const out = migrateStoredTab({ id: "x", kind: "chat", title: "Chat" })
    expect(out).toMatchObject({ id: "x", kind: "vendor" })
  })

  it("defaults an unknown / missing kind to 'vendor'", () => {
    expect(migrateStoredTab({ id: "a" }).kind).toBe("vendor")
    expect(migrateStoredTab({ id: "b", kind: 123 }).kind).toBe("vendor")
  })

  it("preserves current kinds (vendor / terminal / transcript) and their fields", () => {
    expect(migrateStoredTab({ id: "v", kind: "vendor", title: "V" })).toMatchObject({
      kind: "vendor",
      id: "v",
    })
    expect(migrateStoredTab({ id: "t", kind: "terminal", title: "T" }).kind).toBe("terminal")
    expect(migrateStoredTab({ id: "c", kind: "transcript", title: "Chat" }).kind).toBe("transcript")
  })

  it("keeps a file tab's path", () => {
    const out = migrateStoredTab({ id: "f", kind: "file", title: "a.ts", path: "src/a.ts" })
    expect(out).toMatchObject({ kind: "file", path: "src/a.ts" })
  })
})
