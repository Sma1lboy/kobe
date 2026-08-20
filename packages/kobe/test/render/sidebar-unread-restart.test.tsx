/** @jsxImportSource @opentui/react */
/**
 * Issue #22 at the render boundary: a completion this process has never seen
 * — the state a relaunched kobe is in — must still draw as read when the
 * persisted mark covers it.
 *
 * The end-to-end pin (quit kobe, start it again, look at the rail) lives in
 * `test/behavior/pure-tui-unread-restart.test.ts`; this one proves the rail
 * actually consults the durable mark, without a PTY.
 */

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TaskEngineState } from "../../src/client/remote-orchestrator"
import { SidebarTree } from "../../src/tui-react/panes/sidebar/SidebarTree"
import { completionSeenKey } from "../../src/tui-react/workspace/completion-seen"
import { tabsByTask } from "../../src/tui-react/workspace/terminal-tabs-shared"
import { type Task, toTaskId } from "../../src/types/task"
import { renderComponent } from "./harness"

/** The completion's stamp — the daemon keeps publishing it after a restart. */
const AT = 1_760_000_000_000
const HOME_ENV = process.env.KOBE_HOME_DIR

function task(id: string): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repos/rove",
    branch: `feat/${id}`,
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "in_progress",
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as Task
}

const ALPHA = task("alpha")
const BRAVO = task("bravo")

function seedState(seen: Record<string, number>): void {
  const home = mkdtempSync(join(tmpdir(), "kobe-unread-restart-"))
  mkdirSync(join(home, ".config", "rove"), { recursive: true })
  writeFileSync(join(home, ".config", "rove", "state.json"), JSON.stringify({ completionSeen: seen }))
  process.env.KOBE_HOME_DIR = home
}

beforeAll(() => {
  tabsByTask.set("alpha", {
    tabs: [{ kind: "engine", id: "tab-1", title: "build", ordinal: 1 }],
    activeId: "tab-1",
    nextOrdinal: 2,
  })
  tabsByTask.set("bravo", {
    tabs: [{ kind: "engine", id: "tab-1", title: "tests", ordinal: 1 }],
    activeId: "tab-1",
    nextOrdinal: 2,
  })
})

afterAll(() => {
  tabsByTask.clear()
  if (HOME_ENV === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = HOME_ENV
})

const tabState: ReadonlyMap<string, ReadonlyMap<string, TaskEngineState>> = new Map([
  ["alpha", new Map([["tab-1", { state: "turn_complete", at: AT } as TaskEngineState]])],
])

/** `bravo` is what the restored session opens on, so alpha's completed tab is
 *  a row you are NOT looking at — exactly where the lamp is meant to show. */
function tree() {
  return (
    <SidebarTree
      tasks={[ALPHA, BRAVO]}
      selectedId="bravo"
      selectedTabId="tab-1"
      onSelect={() => {}}
      focused={true}
      width={30}
      engineTabState={tabState}
    />
  )
}

test("a completion no persisted mark covers still lights the lamp", async () => {
  seedState({ [completionSeenKey("alpha", "tab-1")]: AT - 1 })
  const { frame } = await renderComponent(tree(), { width: 30, height: 20, providers: { kv: true } })
  expect(await frame()).toContain("●")
})

test("a completion the persisted mark covers reads as already seen", async () => {
  seedState({ [completionSeenKey("alpha", "tab-1")]: AT })
  const { frame } = await renderComponent(tree(), { width: 30, height: 20, providers: { kv: true } })
  expect(await frame()).not.toContain("●")
})
