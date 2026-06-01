/**
 * Per-ChatTab auto-naming (KOB). Drives `runChatTabNamingPass` with a fake
 * TmuxRunner + injected title derivers, against a real Orchestrator + store,
 * so window selection, the recorded-session-id path, the origin fallback, and
 * the manual-rename guard are tested without a live tmux server or on-disk
 * transcripts (those live in the behavior suite).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import {
  type ChatTabNamingDeps,
  type TmuxRunner,
  listChatTabWindows,
  runChatTabNamingPass,
} from "../../src/tmux/chat-tab-naming.ts"

let tmpRoot: string
let store: TaskIndexStore
let orch: Orchestrator

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-chattab-"))
  store = new TaskIndexStore({ homeDir: path.join(tmpRoot, "home") })
  await store.load()
  orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignored
  }
})

async function makeTask(worktree: string | undefined): Promise<string> {
  const task = await orch.createTask({ repo: "/repo" })
  if (worktree !== undefined) await store.update(task.id, { worktreePath: worktree })
  return task.id
}

/**
 * Fake runner. `windows` is the list-windows reply (one `index\tsessionId`
 * per line); `autoRenameOff` is the set of window indices whose
 * automatic-rename reads off (manually named). Records every rename-window.
 */
function fakeDeps(opts: {
  windows: string
  autoRenameOff?: number[]
  titleFromSessionId?: (vendor: string, sessionId: string) => string
  titleFromWorktree?: (worktree: string, vendor: string) => string
}): { deps: ChatTabNamingDeps; renames: Array<{ index: string; title: string }> } {
  const renames: Array<{ index: string; title: string }> = []
  const off = new Set(opts.autoRenameOff ?? [])
  const runner: TmuxRunner = {
    async capture(args) {
      if (args[0] === "list-windows") return { code: 0, stdout: opts.windows }
      if (args[0] === "show-window-options") {
        const target = args[args.indexOf("-t") + 1] // =session:index
        const index = Number.parseInt(target.split(":")[1] ?? "", 10)
        return { code: 0, stdout: off.has(index) ? "automatic-rename off\n" : "" }
      }
      return { code: 1, stdout: "" }
    },
    async run(args) {
      if (args[0] === "rename-window") {
        const target = args[args.indexOf("-t") + 1]
        renames.push({ index: target.split(":")[1] ?? "", title: args[args.length - 1] })
      }
      return 0
    },
  }
  return {
    deps: {
      runner,
      titleFromSessionId: async (v, s) => opts.titleFromSessionId?.(v, s) ?? "",
      titleFromWorktree: async (w, v) => opts.titleFromWorktree?.(w, v) ?? "",
    },
    renames,
  }
}

describe("listChatTabWindows", () => {
  it("parses index + recorded session id, tolerating empty ids", async () => {
    const runner: TmuxRunner = {
      async capture() {
        return { code: 0, stdout: "1\tabc-123\n2\t\n3\tdef-456\n" }
      },
      async run() {
        return 0
      },
    }
    expect(await listChatTabWindows("kobe-x", runner)).toEqual([
      { index: 1, sessionId: "abc-123" },
      { index: 2, sessionId: "" },
      { index: 3, sessionId: "def-456" },
    ])
  })

  it("returns [] when the session is gone", async () => {
    const runner: TmuxRunner = {
      async capture() {
        return { code: 1, stdout: "" }
      },
      async run() {
        return 0
      },
    }
    expect(await listChatTabWindows("kobe-x", runner)).toEqual([])
  })
})

describe("runChatTabNamingPass", () => {
  it("names each window with a recorded session id from its own transcript", async () => {
    await makeTask("/wt/a")
    const { deps, renames } = fakeDeps({
      windows: "1\tsess-1\n2\tsess-2\n",
      titleFromSessionId: (_v, s) => (s === "sess-1" ? "first tab" : "second tab"),
    })

    const n = await runChatTabNamingPass(orch, deps)

    expect(n).toBe(2)
    expect(renames).toEqual([
      { index: "1", title: "first tab" },
      { index: "2", title: "second tab" },
    ])
  })

  it("skips a window that was named manually (automatic-rename off)", async () => {
    await makeTask("/wt/a")
    const { deps, renames } = fakeDeps({
      windows: "1\tsess-1\n2\tsess-2\n",
      autoRenameOff: [1],
      titleFromSessionId: (_v, s) => `title-${s}`,
    })

    await runChatTabNamingPass(orch, deps)

    expect(renames).toEqual([{ index: "2", title: "title-sess-2" }])
  })

  it("falls back to the task's first session for the origin window without a recorded id (codex)", async () => {
    await makeTask("/wt/a")
    const { deps, renames } = fakeDeps({
      windows: "2\t\n3\t\n", // no recorded ids; lowest index (2) is the origin
      titleFromWorktree: () => "task first prompt",
    })

    await runChatTabNamingPass(orch, deps)

    // Only the origin (index 2) is named; the non-origin id-less window is left.
    expect(renames).toEqual([{ index: "2", title: "task first prompt" }])
  })

  it("does not rename when the derived title is empty (no prompt yet)", async () => {
    await makeTask("/wt/a")
    const { deps, renames } = fakeDeps({ windows: "1\tsess-1\n", titleFromSessionId: () => "" })
    expect(await runChatTabNamingPass(orch, deps)).toBe(0)
    expect(renames).toEqual([])
  })

  it("skips a task that has no worktree yet", async () => {
    await makeTask(undefined) // a task with no worktree yet
    const { deps, renames } = fakeDeps({ windows: "1\tsess-1\n", titleFromSessionId: () => "should not run" })
    await runChatTabNamingPass(orch, deps)
    expect(renames).toEqual([])
  })
})
