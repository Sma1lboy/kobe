/** @jsxImportSource @opentui/react */
/**
 * Narrow mode's "↩ Recent" jump row (issue #14, M4/2A): renders as the
 * FIRST navigable row of the sidebar tree, and ⏎ on it activates the recent
 * task — real keys, real tree cursor, no new chord.
 */

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HostSidebar, type HostSidebarProps } from "../../src/tui-react/workspace/host-sidebar"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { act, renderComponent, settle } from "./harness"

const NOOP = (): void => {}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repos/rove",
    branch: `feat/${id}`,
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "in_progress",
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }
}

function sidebarProps(over: Partial<HostSidebarProps> = {}): HostSidebarProps {
  return {
    width: 46,
    nav: "terminal",
    onNavChange: NOOP,
    tasks: [task("alpha"), task("bravo")],
    selectedId: "alpha",
    selectedTabId: null,
    onSelect: NOOP,
    onActivate: NOOP,
    onSelectTab: NOOP,
    focused: true,
    onAddTask: NOOP,
    onDeleteRequest: NOOP,
    onArchiveRequest: NOOP,
    onRenameRequest: NOOP,
    onPinRequest: NOOP,
    moveMode: false,
    onMoveRequest: NOOP,
    onMoveModeExit: NOOP,
    onLocalMergeRequest: NOOP,
    onSearchActiveChange: NOOP,
    headerStatus: { label: "", emphasize: false },
    onHeaderStatusClick: NOOP,
    zenActive: false,
    onZenClick: NOOP,
    onFocusRequest: NOOP,
    ...over,
  }
}

describe("recent jump row", () => {
  it("renders first and ⏎ on it activates the recent task", async () => {
    process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-recent-row-"))
    const activated: string[] = []
    const recent = task("bravo")
    const { frame, mockInput } = await renderComponent(
      <box flexDirection="row" height={24}>
        <HostSidebar {...sidebarProps({ recentTask: recent, onActivate: (id) => activated.push(id) })} />
      </box>,
      { width: 46, height: 24, providers: { kv: true, notifications: true } },
    )
    await settle()
    const text = await frame()
    expect(text).toContain("↩ Recent: bravo")
    // The row is above the first task row.
    const lines = text.split("\n")
    expect(lines.findIndex((l) => l.includes("↩ Recent"))).toBeLessThan(lines.findIndex((l) => l.includes("alpha")))

    // gg jumps the cursor to the top row (the recent row), ⏎ activates it.
    act(() => mockInput.pressKey("g"))
    act(() => mockInput.pressKey("g"))
    await settle()
    act(() => mockInput.pressEnter())
    await settle()
    expect(activated).toEqual([recent.id])
  })

  it("per-task verbs are inert on the shortcut row", async () => {
    process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-recent-row-"))
    const deleted: string[] = []
    const { mockInput } = await renderComponent(
      <box flexDirection="row" height={24}>
        <HostSidebar {...sidebarProps({ recentTask: task("bravo"), onDeleteRequest: (id) => deleted.push(id) })} />
      </box>,
      { width: 46, height: 24, providers: { kv: true, notifications: true } },
    )
    await settle()
    act(() => mockInput.pressKey("g"))
    act(() => mockInput.pressKey("g"))
    await settle()
    act(() => mockInput.pressKey("d"))
    await settle()
    expect(deleted).toEqual([])
  })

  it("absent recentTask renders no jump row", async () => {
    process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-recent-row-"))
    const { frame } = await renderComponent(
      <box flexDirection="row" height={24}>
        <HostSidebar {...sidebarProps()} />
      </box>,
      { width: 46, height: 24, providers: { kv: true, notifications: true } },
    )
    await settle()
    expect(await frame()).not.toContain("↩ Recent")
  })
})
