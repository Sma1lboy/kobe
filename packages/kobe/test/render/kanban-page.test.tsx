/** @jsxImportSource @opentui/react */
/**
 * KanbanPage selection + detail drawer — mounts the REAL page against a fake
 * orchestrator and drives the actual keyboard flow: the board renders its
 * cards, arrow keys anchor/move the card cursor, Enter opens the issue-detail
 * drawer (title + full description + start config), esc dismisses it back to
 * the board. Pins the interaction grammar, not pixels.
 */
import { describe, expect, it } from "bun:test"
import type { RepoIssues } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import type { RemoteOrchestrator } from "../../src/client/remote-orchestrator"
import { KanbanPage } from "../../src/tui-react/component/kanban-page"
import { modalActive } from "../../src/tui-react/lib/keymap"
import { act, renderComponent, settle } from "./harness"

const board: RepoIssues = {
  repoRoot: "/repo/demo",
  exists: true,
  nextId: 4,
  issues: [
    { id: 1, title: "Fix the flake", status: "open", created: "2026-07-10", body: "repro steps live here" },
    { id: 2, title: "Polish the board", status: "open", created: "2026-07-09", body: "" },
    { id: 3, title: "Shipped thing", status: "done", created: "2026-07-01", body: "" },
  ],
}

function fakeOrchestrator(): RemoteOrchestrator {
  return {
    listTasks: () => [{ id: "t1", repo: "/repo/demo" }],
    listIssues: async () => board,
    activeTaskSignal: () => ({ get: () => null }),
  } as unknown as RemoteOrchestrator
}

async function mountPage() {
  const handle = await renderComponent(
    <KanbanPage
      orchestrator={fakeOrchestrator()}
      onClose={() => {}}
      onStartChat={async () => {}}
      onOpenTask={() => {}}
    />,
    // Wide enough that card titles don't wrap; tall enough for the drawer.
    { providers: { dialog: true }, width: 120, height: 44 },
  )
  // listIssues resolves async — let the board load land before asserting.
  await act(() => settle())
  return handle
}

describe("KanbanPage", () => {
  it("renders the board's cards in their columns", async () => {
    const { frame } = await mountPage()
    const text = await frame()
    expect(text).toContain("Fix the flake")
    expect(text).toContain("Polish the board")
    expect(text).toContain("Shipped thing")
  })

  it("enter opens the selected card's detail drawer, esc dismisses it", async () => {
    const { frame, mockInput } = await mountPage()
    // First arrow anchors the cursor on the first visible card (id 1).
    act(() => mockInput.pressArrow("down"))
    await frame()
    act(() => mockInput.pressEnter())
    const drawer = await frame()
    // The drawer shows the FULL story: id, description editor, start config.
    expect(drawer).toContain("#1")
    expect(drawer).toContain("repro steps live here")
    expect(drawer).toContain("WORKSPACE")
    expect(modalActive()).toBe(true)
    mockInput.pressEscape()
    await settle()
    await frame()
    // Dismissal is asserted on the dialog stack, not the frame — the test
    // renderer keeps stale overlay cells after a dialog unmount (the same
    // reason dialog-confirm/dialog-stack assert results, not frames).
    expect(modalActive()).toBe(false)
  })

  it("n opens the new-story intake; esc cancels without touching the store", async () => {
    let mutations = 0
    const orch = {
      listTasks: () => [{ id: "t1", repo: "/repo/demo" }],
      listIssues: async () => board,
      activeTaskSignal: () => ({ get: () => null }),
      mutateIssue: async () => {
        mutations += 1
        return board
      },
    } as unknown as RemoteOrchestrator
    const { frame, mockInput } = await renderComponent(
      <KanbanPage orchestrator={orch} onClose={() => {}} onStartChat={async () => {}} onOpenTask={() => {}} />,
      { providers: { dialog: true }, width: 120, height: 44 },
    )
    await act(() => settle())
    act(() => mockInput.pressKey("n"))
    const intake = await frame()
    expect(intake).toContain("NEW STORY")
    expect(modalActive()).toBe(true)
    mockInput.pressEscape()
    await settle()
    await frame()
    expect(modalActive()).toBe(false)
    expect(mutations).toBe(0)
  })

  it("d asks for confirmation before deleting the selected card", async () => {
    const { frame, mockInput } = await mountPage()
    act(() => mockInput.pressArrow("down"))
    await frame()
    act(() => mockInput.pressKey("d"))
    const confirm = await frame()
    expect(confirm).toContain("Delete story #1?")
    expect(modalActive()).toBe(true)
  })

  it("enter inside the drawer hands the start request up with the chosen placement", async () => {
    let started = null as { placement?: string; vendor?: string } | null
    const orch = fakeOrchestrator()
    const { frame, mockInput } = await renderComponent(
      <KanbanPage
        orchestrator={orch}
        onClose={() => {}}
        onStartChat={async (req) => {
          started = req
        }}
        onOpenTask={() => {}}
      />,
      { providers: { dialog: true }, width: 120, height: 44 },
    )
    await act(() => settle())
    act(() => mockInput.pressArrow("down"))
    await frame()
    act(() => mockInput.pressEnter())
    await frame()
    // ↓ moves the workspace placement off the worktreeBg default to the
    // second option (worktree) — proves the picker steers AND that the
    // background trigger is the drawer's default.
    act(() => mockInput.pressArrow("down"))
    await frame()
    act(() => mockInput.pressEnter())
    await settle()
    expect(started).not.toBeNull()
    expect(started?.placement).toBe("worktree")
  })
})
