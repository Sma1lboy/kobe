import { describe, expect, test } from "vitest"
import {
  type Row,
  reconcileRows,
  sameFileList,
  sameStatusEntries,
  truncatePathTail,
} from "../../src/tui/panes/filetree/rows"

function file(path: string, depth = 0): Row {
  return { kind: "file", path, name: path.split("/").pop() ?? path, depth }
}
function dir(path: string, expanded: boolean): Row {
  return { kind: "dir", path, name: path, depth: 0, expanded, hasChildren: true }
}
function status(path: string, added = 1, deleted = 0): Row {
  return { kind: "status", path, status: "M", added, deleted }
}

describe("reconcileRows", () => {
  test("identical rebuild returns the PREVIOUS array itself (no downstream notify)", () => {
    const prev = [dir("src", true), file("src/a.ts", 1), file("src/b.ts", 1)]
    const next = [dir("src", true), file("src/a.ts", 1), file("src/b.ts", 1)]
    expect(reconcileRows(prev, next)).toBe(prev)
  })

  test("unchanged rows keep their previous object identity when one row changes", () => {
    const prev = [dir("src", true), file("src/a.ts", 1), file("src/b.ts", 1)]
    const next = [dir("src", true), file("src/a.ts", 1), file("src/c.ts", 1)]
    const out = reconcileRows(prev, next)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(prev[0])
    expect(out[1]).toBe(prev[1])
    expect(out[2]).toBe(next[2])
  })

  test("a field change breaks reuse for that row only (dir collapse)", () => {
    const prev = [dir("src", true), file("src/a.ts", 1)]
    const next = [dir("src", false)]
    const out = reconcileRows(prev, next)
    expect(out[0]).toBe(next[0])
    expect(out).toHaveLength(1)
  })

  test("status rows reuse on equal diff stats, replace on changed stats", () => {
    const prev = [status("a.ts", 3, 1), status("b.ts", 0, 2)]
    const out = reconcileRows(prev, [status("a.ts", 3, 1), status("b.ts", 5, 2)])
    expect(out[0]).toBe(prev[0])
    expect(out[0]).not.toBe(undefined)
    expect(out[1]).not.toBe(prev[1])
  })

  test("reorder reuses objects but returns a new array (positions changed)", () => {
    const prev = [file("a.ts"), file("b.ts")]
    const next = [file("b.ts"), file("a.ts")]
    const out = reconcileRows(prev, next)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(prev[1])
    expect(out[1]).toBe(prev[0])
  })

  test("empty prev passes next through untouched", () => {
    const next = [file("a.ts")]
    expect(reconcileRows([], next)).toBe(next)
  })
})

describe("content-equality signal guards", () => {
  test("sameFileList: identical git ls-files output suppresses the signal", () => {
    expect(sameFileList(["a.ts", "b.ts"], ["a.ts", "b.ts"])).toBe(true)
    expect(sameFileList(["a.ts"], ["a.ts", "b.ts"])).toBe(false)
    expect(sameFileList(null, ["a.ts"])).toBe(false)
    expect(sameFileList(null, null)).toBe(true)
  })

  test("sameStatusEntries: equal status+numstat suppresses; any field change notifies", () => {
    const a = [{ path: "a.ts", status: "M" as const, added: 1, deleted: 0 }]
    expect(sameStatusEntries(a, [{ path: "a.ts", status: "M", added: 1, deleted: 0 }])).toBe(true)
    expect(sameStatusEntries(a, [{ path: "a.ts", status: "M", added: 2, deleted: 0 }])).toBe(false)
    expect(sameStatusEntries(a, null)).toBe(false)
  })
})

describe("truncatePathTail", () => {
  test("returns the path unchanged when it fits the budget", () => {
    expect(truncatePathTail("src/a.ts", 20)).toBe("src/a.ts")
    expect(truncatePathTail("src/a.ts", 8)).toBe("src/a.ts")
  })

  test("keeps the tail (leaf) and marks the elided prefix with a leading …", () => {
    expect(truncatePathTail("components/sidebar/Sidebar.tsx", 14)).toBe("…r/Sidebar.tsx")
  })

  test("never bisects a surrogate pair — emoji stay intact", () => {
    expect(truncatePathTail("src/aaaaa-🎉🎉🎉.ts", 8)).toBe("…-🎉🎉🎉.ts")
  })

  test("max <= 0 leaves no room, so yields the empty string", () => {
    expect(truncatePathTail("a/b/c.ts", 0)).toBe("")
  })
})
