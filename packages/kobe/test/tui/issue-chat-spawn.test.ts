/**
 * Background issue-chat spawn (`tui/workspace/issue-chat-spawn.ts`) — the
 * kanban board's trigger contract.
 *
 * Why these matter: a background Start must (1) actually LAUNCH the engine
 * with the story prompt riding the argv — the pre-2026-07 behavior parked
 * the prompt until the first visit, so "started in background" ran nothing —
 * and (2) leave a tab snapshot that makes a later visit ATTACH to the same
 * hosted session (same `taskId::tab-1` key, spawned=true, pinned session id)
 * instead of spawning a second engine on the same worktree.
 *
 * State is isolated via `KOBE_HOME_DIR` (interactiveEngineCommand and the
 * protocol gates read the shared state.json).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildIssueChatBackgroundSpawn } from "../../src/tui/workspace/issue-chat-spawn.ts"
import type { EngineTab } from "../../src/tui/workspace/terminal-tabs-core.ts"

let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-issue-spawn-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

const story: Issue = {
  id: 7,
  title: "Fix the flaky poll",
  status: "open",
  created: "2026-07-13",
  body: "It flakes.",
}

function build() {
  return buildIssueChatBackgroundSpawn({
    issue: story,
    taskId: "task-9",
    repoRoot: "/repo",
    worktreePath: "/repo/.wt/task-9",
    vendor: "claude",
    api: "kobe api",
    shell: "/bin/zsh",
  })
}

describe("buildIssueChatBackgroundSpawn", () => {
  it("launches the engine under the task's first-tab key with the story prompt in the argv", () => {
    const spawn = build()
    expect(spawn.ptyKey).toBe("task-9::tab-1")
    expect(spawn.command.slice(0, 2)).toEqual(["/bin/zsh", "-ilc"])
    const script = spawn.command[2] ?? ""
    // The prompt IS the launch — no held prompt, no first-visit wait.
    expect(script).toContain("Work on user story #7: Fix the flaky poll")
    // The self-report instruction the agent uses to move its own card.
    expect(script).toContain("issue-set-status --repo . --id 7 --status done")
  })

  it("snapshot marks tab-1 spawned with the SAME session id the argv pins — a visit attaches, a restart resumes", () => {
    const spawn = build()
    const tab = spawn.tabsSnapshot.tabs[0] as EngineTab
    expect(spawn.tabsSnapshot.tabs).toHaveLength(1)
    expect(spawn.tabsSnapshot.activeId).toBe("tab-1")
    expect(tab.kind).toBe("engine")
    expect(tab.spawned).toBe(true)
    expect(tab.sessionId).toBeTruthy()
    expect(spawn.command[2]).toContain(`--session-id ${tab.sessionId}`)
  })
})
