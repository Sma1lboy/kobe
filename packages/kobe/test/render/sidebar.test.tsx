/** @jsxImportSource @opentui/react */
/**
 * Sidebar — the task rail (src/tui-react/panes/sidebar/Sidebar.tsx). Regression
 * guard for the selected-row background: it must paint across the FULL scroll
 * content width, not stop one cell short. React delta: props are plain values,
 * not accessors.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { type CapturedFrame, RGBA, TextAttributes } from "@opentui/core"
import { setTransparentBackground } from "../../src/tui-react/context/theme"
import { Sidebar } from "../../src/tui-react/panes/sidebar/Sidebar"
import { BUNDLED_THEME_JSONS } from "../../src/tui/context/theme/bundled"
import { resolveThemeSlotHex } from "../../src/tui/context/theme/hex"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { act, renderComponent } from "./harness"

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

function findSpan(frame: CapturedFrame, needle: string) {
  return frame.lines.flatMap((line) => line.spans).find((span) => span.text.includes(needle))
}

function backgroundWidth(frame: CapturedFrame, needle: string, bg: RGBA): number {
  const line = findLine(frame, needle)
  if (!line) return 0
  return line.spans.reduce((sum, span) => (span.bg.equals(bg) ? sum + span.width : sum), 0)
}

beforeEach(() => setTransparentBackground(false))
afterEach(() => setTransparentBackground(true))

describe("Sidebar", () => {
  it("paints the selected row background across the full scroll content width", async () => {
    const selected = task()
    const bgHex = resolveThemeSlotHex(BUNDLED_THEME_JSONS.claude!, "backgroundElement")
    expect(bgHex).not.toBeNull()
    const selectedBg = RGBA.fromHex(bgHex!)
    const { destroy, spans } = await renderComponent(
      <Sidebar
        width={30}
        tasks={[selected]}
        selectedId={selected.id}
        onSelect={() => {}}
        worktreeChanges={new Map([[selected.worktreePath, { added: 0, deleted: 0 }]])}
      />,
      { width: 34, height: 14 },
    )

    try {
      const frame = await spans()
      // The selected row background must fill the full 30-cell rail width, not
      // stop short — the regression this guards against left a bare gutter
      // column at the row's trailing edge.
      expect(backgroundWidth(frame, "alpha task", selectedBg)).toBe(30)
    } finally {
      destroy()
    }
  })

  it("reserves the focus accent for the pane border and keeps row metadata readable", async () => {
    const selected = task()
    const theme = BUNDLED_THEME_JSONS.claude!
    const text = RGBA.fromHex(resolveThemeSlotHex(theme, "text")!)
    const textMuted = RGBA.fromHex(resolveThemeSlotHex(theme, "textMuted")!)
    const primary = RGBA.fromHex(resolveThemeSlotHex(theme, "primary")!)
    const borderSubtle = RGBA.fromHex(resolveThemeSlotHex(theme, "borderSubtle")!)
    const { destroy, spans } = await renderComponent(
      <Sidebar
        width={30}
        tasks={[selected]}
        selectedId={selected.id}
        onSelect={() => {}}
        focused
        worktreeChanges={new Map([[selected.worktreePath, { added: 7, deleted: 2 }]])}
      />,
      { width: 34, height: 14 },
    )

    try {
      const frame = await spans()
      const brand = findSpan(frame, "KOBE")
      const activeView = findSpan(frame, "Workspace")
      const branch = findSpan(frame, "main")
      const selectedLine = findLine(frame, "alpha task")
      const marker = selectedLine?.spans.find((span) => span.text.includes("▌"))
      const sectionLine = findLine(frame, "TASKS")
      const divider = sectionLine?.spans.find((span) => span.text.includes("─"))

      expect(brand?.fg.equals(textMuted)).toBe(true)
      expect(activeView?.fg.equals(text)).toBe(true)
      expect(activeView?.fg.equals(primary)).toBe(false)
      expect(marker?.fg.equals(text)).toBe(true)
      expect(marker?.fg.equals(primary)).toBe(false)
      expect(branch?.fg.equals(textMuted)).toBe(true)
      expect((branch?.attributes ?? 0) & TextAttributes.DIM).toBe(0)
      expect(divider?.fg.equals(borderSubtle)).toBe(true)
    } finally {
      destroy()
    }
  })

  it("separates the active task from the movable sidebar cursor", async () => {
    const selected = task()
    const cursorTarget = task({
      id: "task-2",
      title: "beta task",
      branch: "feat/beta",
      worktreePath: "/repo/kobe/.kobe/worktrees/beta",
    })
    const theme = BUNDLED_THEME_JSONS.claude!
    const selectedBg = RGBA.fromHex(resolveThemeSlotHex(theme, "background")!)
    const cursorBg = RGBA.fromHex(resolveThemeSlotHex(theme, "backgroundElement")!)
    const { destroy, mockInput, spans } = await renderComponent(
      <Sidebar
        width={30}
        tasks={[selected, cursorTarget]}
        selectedId={selected.id}
        onSelect={() => {}}
        focused
        worktreeChanges={
          new Map([
            [selected.worktreePath, { added: 0, deleted: 0 }],
            [cursorTarget.worktreePath, { added: 0, deleted: 0 }],
          ])
        }
      />,
      { width: 34, height: 16 },
    )

    try {
      await act(async () => mockInput.pressArrow("down"))
      const frame = await spans()
      expect(findSpan(frame, "alpha task")?.bg.equals(selectedBg)).toBe(true)
      expect(backgroundWidth(frame, "beta task", cursorBg)).toBe(30)
    } finally {
      destroy()
    }
  })

  it("strengthens section dividers when transparent mode removes panel fills", async () => {
    const selected = task()
    const theme = BUNDLED_THEME_JSONS.claude!
    const border = RGBA.fromHex(resolveThemeSlotHex(theme, "border")!)
    setTransparentBackground(true)
    const { destroy, spans } = await renderComponent(
      <Sidebar
        width={30}
        tasks={[selected]}
        selectedId={selected.id}
        onSelect={() => {}}
        focused
        worktreeChanges={new Map([[selected.worktreePath, { added: 0, deleted: 0 }]])}
      />,
      { width: 34, height: 14 },
    )

    try {
      const sectionLine = findLine(await spans(), "TASKS")
      const divider = sectionLine?.spans.find((span) => span.text.includes("─"))
      expect(divider?.fg.equals(border)).toBe(true)
    } finally {
      destroy()
    }
  })
})
