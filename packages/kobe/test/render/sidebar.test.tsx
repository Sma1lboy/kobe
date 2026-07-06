import { describe, expect, it } from "bun:test"
import { type CapturedFrame, RGBA } from "@opentui/core"
import { BUNDLED_THEME_JSONS } from "../../src/tui/context/theme/bundled"
import { resolveThemeSlotHex } from "../../src/tui/context/theme/hex"
import { Sidebar } from "../../src/tui/panes/sidebar/Sidebar"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { renderComponent } from "./harness"

function task(overrides: Omit<Partial<Task>, "id"> & { id?: string } = {}): Task {
  return {
    id: toTaskId(overrides.id ?? "task-1"),
    title: "alpha task",
    repo: "/repo/kobe",
    branch: "main",
    worktreePath: "/repo/kobe/.kobe/worktrees/alpha",
    kind: "task",
    status: "backlog",
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task
}

function findLine(frame: CapturedFrame, needle: string) {
  return frame.lines.find((line) => line.spans.some((span) => span.text.includes(needle)))
}

function backgroundWidth(frame: CapturedFrame, needle: string, bg: RGBA): number {
  const line = findLine(frame, needle)
  if (!line) return 0
  return line.spans.reduce((sum, span) => (span.bg.equals(bg) ? sum + span.width : sum), 0)
}

describe("Sidebar", () => {
  it("paints the selected row background across the full scroll content width", async () => {
    const selected = task()
    const bgHex = resolveThemeSlotHex(BUNDLED_THEME_JSONS.claude!, "backgroundElement")
    expect(bgHex).not.toBeNull()
    const selectedBg = RGBA.fromHex(bgHex!)
    const { destroy, spans } = await renderComponent(
      () => (
        <Sidebar
          width={() => 30}
          tasks={() => [selected]}
          selectedId={() => selected.id}
          onSelect={() => {}}
          worktreeChanges={() => new Map([[selected.worktreePath, { added: 0, deleted: 0 }]])}
        />
      ),
      { width: 34, height: 14 },
    )

    try {
      const frame = await spans()
      expect(backgroundWidth(frame, "alpha task", selectedBg)).toBe(29)
    } finally {
      destroy()
    }
  })
})
