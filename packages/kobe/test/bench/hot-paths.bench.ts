import { bench, describe } from "vitest"
import { type Binding, type RegisteredBinding, dispatchKeyEvent, matchKey } from "../../src/tui/lib/keymap-dispatch"
import { parsePorcelain } from "../../src/tui/panes/filetree/git"
import { type Row, reconcileRows } from "../../src/tui/panes/filetree/rows"
import { buildSidebarRowView } from "../../src/tui/panes/sidebar/row-view"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"

let layerId = 0
function layer(keys: string[]): RegisteredBinding {
  const bindings: Binding[] = keys.map((key) => ({ key, cmd: () => {} }))
  return { id: ++layerId, config: () => ({ bindings }) }
}

const stack = Array.from({ length: 25 }, (_, i) => layer([`f${i + 1}`, `alt+f${i + 1}`, `ctrl+f${i + 1}`]))
const noopEvent = (name: string) => ({ defaultPrevented: false, preventDefault() {}, name })

describe("keymap dispatch (25-group stack)", () => {
  bench("matchKey: plain letter", () => {
    matchKey(noopEvent("k") as Parameters<typeof matchKey>[0])
  })

  bench("dispatch: hit in the top group", () => {
    dispatchKeyEvent(stack, noopEvent("f25"))
  })

  bench("dispatch: hit in the bottom group (full walk)", () => {
    dispatchKeyEvent(stack, noopEvent("f1"))
  })

  bench("dispatch: miss (full walk, no fire)", () => {
    dispatchKeyEvent(stack, noopEvent("z"))
  })
})

const porcelain5k = Array.from({ length: 5_000 }, (_, i) => {
  const status = i % 7 === 0 ? "??" : i % 3 === 0 ? " M" : "M "
  return `${status} src/dir-${i % 40}/file-${i}.ts`
}).join("\n")

describe("parsePorcelain", () => {
  bench("5k-line status", () => {
    parsePorcelain(porcelain5k)
  })
})

function fileRow(i: number): Row {
  return { kind: "file", path: `src/dir-${i % 40}/file-${i}.ts`, name: `file-${i}.ts`, depth: 2 }
}
const prevRows: Row[] = Array.from({ length: 1_000 }, (_, i) => fileRow(i))
const sameRows: Row[] = Array.from({ length: 1_000 }, (_, i) => fileRow(i))
const oneChanged: Row[] = sameRows.map((row, i) => (i === 500 ? { ...row, name: "renamed.ts" } : row))

describe("reconcileRows (1k rows)", () => {
  bench("unchanged rebuild (returns prev array)", () => {
    reconcileRows(prevRows, sameRows)
  })

  bench("one row changed", () => {
    reconcileRows(prevRows, oneChanged)
  })
})

const benchTask: Task = {
  id: toTaskId("bench-task"),
  title: "fix sidebar",
  repo: "/repo/kobe",
  branch: "feature/sidebar",
  worktreePath: "/repo/kobe/worktrees/sidebar",
  kind: "task",
  status: "in_progress",
  archived: false,
  pinned: false,
  vendor: "claude",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as Task

describe("buildSidebarRowView", () => {
  bench("running task row", () => {
    buildSidebarRowView({
      task: benchTask,
      activity: { state: "running", at: 1 },
      live: false,
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
    })
  })
})
