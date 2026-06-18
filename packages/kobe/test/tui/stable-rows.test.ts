import { describe, expect, test } from "vitest"
import { reconcileStableRows } from "../../src/tui/lib/stable-rows"

type Row = { id: string; label: string }

const keyOf = (row: Row) => row.id
const equals = (a: Row, b: Row) => a.label === b.label

describe("reconcileStableRows", () => {
  test("returns the previous array when every row is unchanged in place", () => {
    const prev = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]
    const next = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]
    expect(reconcileStableRows(prev, next, keyOf, equals)).toBe(prev)
  })

  test("reuses unchanged row objects while keeping changed rows fresh", () => {
    const prev = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]
    const next = [
      { id: "a", label: "A" },
      { id: "b", label: "B2" },
    ]
    const out = reconcileStableRows(prev, next, keyOf, equals)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(prev[0])
    expect(out[1]).toBe(next[1])
  })

  test("can reuse unchanged rows after a move", () => {
    const prev = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]
    const next = [
      { id: "b", label: "B" },
      { id: "a", label: "A" },
    ]
    const out = reconcileStableRows(prev, next, keyOf, equals)
    expect(out[0]).toBe(prev[1])
    expect(out[1]).toBe(prev[0])
  })

  test("samePosition mode keeps moved rows fresh", () => {
    const prev = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]
    const next = [
      { id: "b", label: "B" },
      { id: "a", label: "A" },
    ]
    const out = reconcileStableRows(prev, next, keyOf, equals, { samePosition: true })
    expect(out[0]).toBe(next[0])
    expect(out[1]).toBe(next[1])
  })
})
