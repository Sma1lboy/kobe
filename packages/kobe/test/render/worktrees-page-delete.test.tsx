/** @jsxImportSource @opentui/react */
/**
 * Deleting a worktree removes its row IMMEDIATELY, without waiting for the
 * daemon.
 *
 * `git worktree remove` on a worktree with a populated `node_modules` is
 * seconds of real filesystem work; the page used to `await` it before
 * refetching, so the row sat there looking hung. These tests pin the
 * optimistic behavior: gone on confirm, back on failure.
 */

import { expect, test } from "bun:test"
import { WorktreesPage } from "../../src/tui-react/component/worktrees-page"
import { renderComponent } from "./harness"

const ROW = {
  repo: "/x/kobe",
  path: "/x/wt/feature-a",
  branch: "feature-a",
  head: "abc1234",
  dirty: false,
  kobeManaged: true,
  lastActivityMs: 0,
  createdAtMs: 0,
  branchOnRemote: false,
  verdict: "fresh",
  verdictReason: "fresh",
}

function orchestrator(removeWorktree: (path: string, force: boolean) => Promise<void>) {
  return {
    listWorktrees: async () => [{ repo: "/x/kobe", worktrees: [ROW] }],
    listTasks: () => [],
    removeWorktree,
  } as never
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100))

test("the row disappears before the daemon delete resolves", async () => {
  let release = (): void => {}
  const pending = new Promise<void>((r) => {
    release = r
  })
  const { frame, mockInput } = await renderComponent(
    <WorktreesPage orchestrator={orchestrator(() => pending)} onClose={() => {}} />,
    { width: 70, height: 20, providers: { dialog: true } },
  )
  await settle()
  expect(await frame()).toContain("feature-a")

  mockInput.typeText("d")
  await settle()
  mockInput.pressEnter() // confirm
  await settle()

  // Daemon call still in flight — the row must already be gone.
  expect(await frame()).not.toContain("feature-a")
  release()
})

test("a failed delete puts the row back", async () => {
  const { frame, mockInput } = await renderComponent(
    <WorktreesPage orchestrator={orchestrator(() => Promise.reject(new Error("boom")))} onClose={() => {}} />,
    { width: 70, height: 20, providers: { dialog: true } },
  )
  await settle()
  mockInput.typeText("d")
  await settle()
  mockInput.pressEnter()
  await settle()
  expect(await frame()).toContain("feature-a")
})
