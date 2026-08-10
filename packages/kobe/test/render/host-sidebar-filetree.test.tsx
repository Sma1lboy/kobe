/** @jsxImportSource @opentui/react */
/**
 * Real-render coverage for the two panes that carry first-use key hints:
 * the workspace's HostSidebar (flat + tree mounts, flat keys via
 * `useSidebarBindings`) and the FileTree over a real git worktree. Presses
 * real keys — the hint-extinguish contract IS a keypress side effect.
 */

import { describe, expect, it } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileTree } from "../../src/tui-react/panes/filetree/FileTree"
import { HostSidebar, type HostSidebarProps } from "../../src/tui-react/workspace/host-sidebar"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { act, renderComponent, settle } from "./harness"

const NOOP = (): void => {}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repos/kobe",
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
    mode: "flat",
    width: 28,
    nav: "terminal",
    onNavChange: NOOP,
    tasks: [task("a"), task("b")],
    selectedId: "a",
    selectedTabId: null,
    onSelect: NOOP,
    onActivate: NOOP,
    onSelectTab: NOOP,
    focused: true,
    onHoverChange: NOOP,
    hoverEnabled: false,
    onAddTask: NOOP,
    onDeleteRequest: NOOP,
    onArchiveRequest: NOOP,
    onRenameRequest: NOOP,
    onPinRequest: NOOP,
    moveMode: false,
    onMoveRequest: NOOP,
    onMoveModeExit: NOOP,
    onLocalMergeRequest: NOOP,
    sortMode: "default",
    onSortModeToggle: NOOP,
    projectFilter: null,
    onProjectFilterChange: NOOP,
    onSearchActiveChange: NOOP,
    headerStatus: { label: "", emphasize: false },
    onHeaderStatusClick: NOOP,
    zenActive: false,
    onZenClick: NOOP,
    onFocusRequest: NOOP,
    ...over,
  }
}

function withTempKvHome(): void {
  process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-panes-"))
}

/** Mimic the workspace frame: a bounded ROW container so the sidebar column
 *  stretches to full height and its bottom hint line lands on-screen. */
function inFrameRow(ui: React.ReactNode, height: number) {
  return (
    <box flexDirection="row" height={height}>
      {ui}
    </box>
  )
}

describe("HostSidebar", () => {
  it("flat mount shows the first-use hint; using j extinguishes it and moves the cursor", async () => {
    withTempKvHome()
    const selected: string[] = []
    const { frame, mockInput } = await renderComponent(
      inFrameRow(<HostSidebar {...sidebarProps({ onSelect: (id) => selected.push(id) })} />, 24),
      { width: 28, height: 24, providers: { kv: true, notifications: true } },
    )
    await settle()
    let text = await frame()
    expect(text).toContain("j/k move")
    expect(text).toContain("⏎ open")

    act(() => mockInput.pressKey("j"))
    await settle()
    text = await frame()
    // The pane's own key extinguished its hint — permanently.
    expect(text).not.toContain("j/k move")

    act(() => mockInput.pressEnter())
    await settle()
    expect(selected.length).toBeGreaterThan(0)
  })

  it("tree mount renders the same wrapper without a stale hint", async () => {
    withTempKvHome()
    const { frame } = await renderComponent(inFrameRow(<HostSidebar {...sidebarProps({ mode: "tree" })} />, 24), {
      width: 28,
      height: 24,
      providers: { kv: true, notifications: true },
    })
    await settle()
    const text = await frame()
    expect(text).toContain("feat/a")
    expect(text).toContain("j/k move")
  })
})

describe("FileTree", () => {
  it("lists a real worktree, opens a file with enter, and shows the live footer hint", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kobe-filetree-"))
    execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", {
      cwd: repo,
    })
    writeFileSync(join(repo, "alpha.ts"), "export {}\n")
    writeFileSync(join(repo, "beta.md"), "# beta\n")
    execSync("git add . && git -c user.email=t@t -c user.name=t commit -q -m files", { cwd: repo })

    const opened: string[] = []
    const { frame, mockInput } = await renderComponent(
      <FileTree worktreePath={repo} onOpenFile={(p) => opened.push(p)} focused={true} paneWidth={44} />,
      { width: 44, height: 24 },
    )
    // The listing loads through an async git read — poll the real frame.
    let text = ""
    for (let i = 0; i < 40 && !text.includes("alpha.ts"); i++) {
      await settle(100)
      text = await frame()
    }
    expect(text).toContain("alpha.ts")
    expect(text).toContain("beta.md")
    // First-use footer hint, resolved from the live keymap.
    expect(text).toContain("⏎ open")
    expect(text).toContain("d diff")

    act(() => mockInput.pressEnter())
    await settle()
    expect(opened).toEqual(["alpha.ts"])

    // Switch to the Changes tab and back with the real bracket chords.
    act(() => mockInput.pressKey("]"))
    await settle()
    act(() => mockInput.pressKey("["))
    await settle()
    expect(await frame()).toContain("alpha.ts")
  })

  it("renders the no-task placeholder without a worktree", async () => {
    const { frame } = await renderComponent(<FileTree worktreePath={null} onOpenFile={NOOP} />, {
      width: 40,
      height: 10,
    })
    const text = await frame()
    expect(text.length).toBeGreaterThan(0)
  })
})
