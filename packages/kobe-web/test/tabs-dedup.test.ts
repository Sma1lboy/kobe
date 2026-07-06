import { describe, expect, it } from "vitest"
import { addTab, openFilePreviewTab } from "../src/lib/tabs.ts"

/**
 * File-preview tabs dedup by path — re-opening the same file from the Changes
 * rail must reuse the existing tab, not spawn a duplicate. Engine tabs, by
 * contrast, are independent each time. Verified via the returned tab ids (no
 * module-state harness needed). Each test uses a unique task id so the shared
 * module state doesn't bleed across cases.
 */

describe("tabs file-preview dedup", () => {
  it("returns the SAME tab id when re-opening the same path", () => {
    const first = openFilePreviewTab("task-A", "src/a.ts")
    const again = openFilePreviewTab("task-A", "src/a.ts")
    expect(again).toBe(first)
  })

  it("returns a DIFFERENT tab id for a different path", () => {
    const a = openFilePreviewTab("task-B", "src/a.ts")
    const b = openFilePreviewTab("task-B", "src/b.ts")
    expect(b).not.toBe(a)
  })

  it("dedups per task — same path in another task is its own tab", () => {
    const inC = openFilePreviewTab("task-C", "src/x.ts")
    const inD = openFilePreviewTab("task-D", "src/x.ts")
    expect(inD).not.toBe(inC)
  })

  it("addTab returns a fresh id each call (engine tabs are independent)", () => {
    const t1 = addTab("task-E")
    const t2 = addTab("task-E")
    expect(t1).not.toBe(t2)
    expect(t1).toBeTruthy()
  })
})
