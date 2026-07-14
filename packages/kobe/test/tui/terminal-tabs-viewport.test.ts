/**
 * Viewport tabs (`EngineTab.ptyTask`) + the module tab store — the kanban
 * `projectWorktree` / `project` placement mechanics.
 *
 * Why these matter: a viewport tab presents another task's session inside
 * the PROJECT workspace. If its PTY key, cwd, or launch identity drift from
 * the referenced task, the project strip would spawn a SECOND session on
 * the story's worktree (duplicate engines, orphaned PTYs) instead of
 * attaching to the one the kanban start launched — and the store append is
 * what makes a non-mounted workspace render the new tab at all.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { TabsSnapshotKv } from "../../src/tui-react/workspace/terminal-tabs-persist.ts"
import { appendBackgroundEngineTab, tabsByTask } from "../../src/tui-react/workspace/terminal-tabs-shared.ts"
import { buildIssueTabSpawn } from "../../src/tui/workspace/issue-chat-spawn.ts"
import { type EngineTab, initialTabs, tabCwdFor, tabPtyKeyFor } from "../../src/tui/workspace/terminal-tabs-core.ts"

let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-viewport-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
  tabsByTask.clear()
})

function fakeKv(): TabsSnapshotKv & { writes: Record<string, unknown> } {
  const writes: Record<string, unknown> = {}
  return {
    store: writes,
    writes,
    set(key, value) {
      writes[key] = value
    },
  }
}

const viewport: EngineTab = {
  kind: "engine",
  id: "tab-3",
  title: null,
  ordinal: 3,
  vendor: "claude",
  sessionId: "sess-child",
  spawned: true,
  ptyTask: { id: "child-task", worktree: "/wt/child" },
}

describe("viewport tab key/cwd", () => {
  it("attaches to the referenced task's FIRST session and runs in its worktree", () => {
    expect(tabPtyKeyFor("main-task", viewport)).toBe("child-task::tab-1")
    expect(tabCwdFor(viewport, "/repo/main")).toBe("/wt/child")
    // Ordinary tabs stay keyed under their own task.
    const plain = initialTabs().tabs[0]
    expect(tabPtyKeyFor("main-task", plain)).toBe("main-task::tab-1")
    expect(tabCwdFor(plain, "/repo/main")).toBe("/repo/main")
  })
})

describe("appendBackgroundEngineTab", () => {
  it("appends after the existing strip, persists to BOTH the module map and kv, keeps the given sessionId", () => {
    const kv = fakeKv()
    const { state, tab } = appendBackgroundEngineTab(kv, "main-task", "/bin/zsh", {
      vendor: "claude",
      sessionId: "sess-child",
      ptyTask: { id: "child-task", worktree: "/wt/child" },
    })
    expect(tab.id).toBe("tab-2") // fresh task state has tab-1; append gets the next ordinal
    expect(tab.sessionId).toBe("sess-child")
    expect(tab.spawned).toBe(true)
    expect(state.activeId).toBe(tab.id)
    expect(tabsByTask.get("main-task")).toBe(state)
    expect(kv.writes["terminalTabs.main-task"]).toBe(state)
  })

  it("pins a fresh session id when none is given (the project-checkout chattab)", () => {
    const kv = fakeKv()
    const { tab } = appendBackgroundEngineTab(kv, "main-task", "/bin/zsh", { vendor: "claude" })
    expect(tab.sessionId).toBeTruthy()
    expect(tab.ptyTask).toBeUndefined()
  })
})

describe("buildIssueTabSpawn", () => {
  it("the story prompt rides the appended tab's spawn even though it is not the strip's first tab", () => {
    const kv = fakeKv()
    const { tab } = appendBackgroundEngineTab(kv, "main-task", "/bin/zsh", { vendor: "claude" })
    const spawn = buildIssueTabSpawn({
      taskId: "main-task",
      repoRoot: "/repo/main",
      worktreePath: "/repo/main",
      tab,
      vendor: "claude",
      prompt: "Work on user story #9: do the thing",
      shell: "/bin/zsh",
    })
    expect(spawn.ptyKey).toBe(`main-task::${tab.id}`)
    expect(spawn.command[2]).toContain("Work on user story #9: do the thing")
    expect(spawn.command[2]).toContain(`--session-id ${tab.sessionId}`)
  })
})
