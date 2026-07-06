import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  RemoteOrchestrator,
  decodeUiPrefsPayload,
  parseWorktreeChangesPayload,
  sameWorktreeChangesMap,
} from "../../src/client/remote-orchestrator.ts"

const { logClientError } = vi.hoisted(() => ({ logClientError: vi.fn() }))
vi.mock("@sma1lboy/kobe-daemon/client/client-log", async (importActual) => ({
  ...(await importActual<typeof import("@sma1lboy/kobe-daemon/client/client-log")>()),
  logClientError,
}))

function fakeClient(): { client: KobeDaemonClient; emit: (name: string, payload: unknown) => void } {
  let star: ((frame: { name: string; payload: unknown }) => void) | undefined
  const client = {
    on: (name: string, handler: (frame: { name: string; payload: unknown }) => void) => {
      if (name === "*") star = handler
      return () => {}
    },
    onLifecycle: () => () => {},
  } as unknown as KobeDaemonClient
  return { client, emit: (name, payload) => star?.({ name, payload }) }
}

describe("RemoteOrchestrator channel handling", () => {
  it("reflects the daemon-owned `update` channel in updateSignal", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    expect(orch.updateSignal()()).toBeNull()

    const info = { current: "1.0.0", latest: "1.1.0", hasUpdate: true }
    emit("update", { info })
    expect(orch.updateSignal()()).toEqual(info)

    emit("update", { info: null })
    expect(orch.updateSignal()()).toBeNull()
  })

  it("reflects the `active-task` channel in activeTaskSignal", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    expect(orch.activeTaskSignal()()).toBeNull()

    emit("active-task", { taskId: "t1" })
    expect(orch.activeTaskSignal()()).toBe("t1")

    emit("active-task", { taskId: null })
    expect(orch.activeTaskSignal()()).toBeNull()
  })

  it("reflects projectFilter on the `ui-prefs` channel and tolerates older payloads", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    expect(orch.uiPrefsSignal()()).toBeNull()

    emit("ui-prefs", { theme: "nord", sortMode: "recent", keysCollapsed: true, projectFilter: "/repo/kobe" })
    expect(orch.uiPrefsSignal()()).toMatchObject({
      theme: "nord",
      sortMode: "recent",
      keysCollapsed: true,
      projectFilter: "/repo/kobe",
    })

    emit("ui-prefs", { theme: "nord" })
    expect(orch.uiPrefsSignal()()?.projectFilter).toBeNull()
  })

  it("carries an absent `locale` as '' (UNSET), never 'en' — a payload that omits the language must not reset it", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)

    emit("ui-prefs", { theme: "nord" })
    expect(orch.uiPrefsSignal()()?.locale).toBe("")

    emit("ui-prefs", { theme: "nord", locale: "zh" })
    expect(orch.uiPrefsSignal()()?.locale).toBe("zh")
  })

  it("treats a malformed update payload as null", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    emit("update", undefined)
    expect(orch.updateSignal()()).toBeNull()
  })

  it("prunes engine-state entries for tasks absent from a task.snapshot", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)

    const task = (id: string) => ({
      id,
      title: id,
      repo: "/repo",
      branch: id,
      worktreePath: `/wt/${id}`,
      kind: "worktree",
      status: "idle",
      archived: false,
      pinned: false,
      vendor: "claude",
      createdAt: 1,
      updatedAt: 1,
    })

    emit("task.snapshot", { tasks: [task("t1"), task("t2")] })
    emit("engine-state", { taskId: "t1", state: "running", at: 10 })
    emit("engine-state", { taskId: "t2", state: "error", at: 11 })
    expect([...orch.engineStateSignal()().keys()].sort()).toEqual(["t1", "t2"])

    emit("task.snapshot", { tasks: [task("t1")] })
    const after = orch.engineStateSignal()()
    expect([...after.keys()]).toEqual(["t1"])
    expect(after.get("t1")?.state).toBe("running")

    emit("task.snapshot", { tasks: [task("t1")] })
    expect(orch.engineStateSignal()()).toBe(after)
  })

  describe("task.jobs channel", () => {
    const snapshotTask = (id: string) => ({
      id,
      title: id,
      repo: "/repo",
      branch: id,
      worktreePath: `/wt/${id}`,
      kind: "worktree",
      status: "idle",
      archived: false,
      pinned: false,
      vendor: "claude",
      createdAt: 1,
      updatedAt: 1,
    })

    it("tracks running jobs and clears them on done / error", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      expect(orch.taskJobsSignal()().size).toBe(0)

      emit("task.jobs", { taskId: "t1", kind: "ensureWorktree", phase: "running" })
      emit("task.jobs", { taskId: "t2", kind: "ensureWorktree", phase: "running" })
      expect([...orch.taskJobsSignal()().keys()].sort()).toEqual(["t1", "t2"])
      expect(orch.taskJobsSignal()().get("t1")).toEqual({ kind: "ensureWorktree" })

      emit("task.jobs", { taskId: "t1", kind: "ensureWorktree", phase: "done" })
      expect([...orch.taskJobsSignal()().keys()]).toEqual(["t2"])

      emit("task.jobs", { taskId: "t2", kind: "ensureWorktree", phase: "error", error: "boom" })
      expect(orch.taskJobsSignal()().size).toBe(0)
    })

    it("a replayed terminal phase for an untracked task is a true no-op (no map churn)", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      const before = orch.taskJobsSignal()()
      emit("task.jobs", { taskId: "t9", kind: "ensureWorktree", phase: "done" })
      expect(orch.taskJobsSignal()()).toBe(before)
    })

    it("ignores malformed payloads", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("task.jobs", undefined)
      emit("task.jobs", { taskId: "t1", kind: "somethingElse", phase: "running" })
      emit("task.jobs", { kind: "ensureWorktree", phase: "running" })
      expect(orch.taskJobsSignal()().size).toBe(0)
    })

    it("prunes job entries for tasks absent from a task.snapshot", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)

      emit("task.snapshot", { tasks: [snapshotTask("t1"), snapshotTask("t2")] })
      emit("task.jobs", { taskId: "t1", kind: "ensureWorktree", phase: "running" })
      emit("task.jobs", { taskId: "t2", kind: "ensureWorktree", phase: "running" })

      emit("task.snapshot", { tasks: [snapshotTask("t1")] })
      const after = orch.taskJobsSignal()()
      expect([...after.keys()]).toEqual(["t1"])

      emit("task.snapshot", { tasks: [snapshotTask("t1")] })
      expect(orch.taskJobsSignal()()).toBe(after)
    })
  })

  describe("worktree.changes channel", () => {
    it("starts null (no daemon-collected data → local-poller fallback)", () => {
      const { client } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      expect(orch.worktreeChangesSignal()()).toBeNull()
    })

    it("reflects a pushed map and replaces it wholesale (absent keys drop)", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)

      emit("worktree.changes", {
        changes: { "/wt/a": { added: 2, deleted: 1 }, "/wt/b": { added: 0, deleted: 0 } },
      })
      const first = orch.worktreeChangesSignal()()
      expect(first?.get("/wt/a")).toEqual({ added: 2, deleted: 1 })
      expect(first?.size).toBe(2)

      emit("worktree.changes", { changes: { "/wt/a": { added: 2, deleted: 1 } } })
      const second = orch.worktreeChangesSignal()()
      expect(second?.size).toBe(1)
      expect(second?.has("/wt/b")).toBe(false)
    })

    it("an unchanged push keeps the same map reference (no re-render churn)", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("worktree.changes", { changes: { "/wt/a": { added: 1, deleted: 0 } } })
      const before = orch.worktreeChangesSignal()()
      emit("worktree.changes", { changes: { "/wt/a": { added: 1, deleted: 0 } } })
      expect(orch.worktreeChangesSignal()()).toBe(before)
    })

    it("ignores malformed payloads instead of clobbering a good map", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("worktree.changes", { changes: { "/wt/a": { added: 1, deleted: 0 } } })
      const before = orch.worktreeChangesSignal()()
      emit("worktree.changes", undefined)
      emit("worktree.changes", { changes: "nope" })
      emit("worktree.changes", { changes: { "/wt/a": { added: "two", deleted: 0 } } })
      expect(orch.worktreeChangesSignal()()).toBe(before)
    })
  })

  describe("malformed events are logged before being dropped", () => {
    beforeEach(() => logClientError.mockClear())

    it("logs (and drops) a task.snapshot whose tasks is not an array", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("task.snapshot", { tasks: "nope" })
      expect(orch.tasksSignal()().length).toBe(0)
      expect(logClientError).toHaveBeenCalledTimes(1)
      expect(logClientError).toHaveBeenCalledWith("orch", expect.stringContaining("task.snapshot"))
    })

    it("logs (and drops) an engine-state with non-string fields", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("engine-state", { taskId: 7, state: "running" })
      expect(orch.engineStateSignal()().size).toBe(0)
      expect(logClientError).toHaveBeenCalledTimes(1)
      expect(logClientError).toHaveBeenCalledWith("orch", expect.stringContaining("engine-state"))
    })

    it("logs (and drops) a task.jobs with the wrong kind", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("task.jobs", { taskId: "t1", kind: "somethingElse", phase: "running" })
      expect(orch.taskJobsSignal()().size).toBe(0)
      expect(logClientError).toHaveBeenCalledTimes(1)
      expect(logClientError).toHaveBeenCalledWith("orch", expect.stringContaining("task.jobs"))
    })

    it("logs (and drops) a malformed worktree.changes without clobbering a good map", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("worktree.changes", { changes: { "/wt/a": { added: 1, deleted: 0 } } })
      logClientError.mockClear()
      const before = orch.worktreeChangesSignal()()
      emit("worktree.changes", { changes: "nope" })
      expect(orch.worktreeChangesSignal()()).toBe(before)
      expect(logClientError).toHaveBeenCalledTimes(1)
      expect(logClientError).toHaveBeenCalledWith("orch", expect.stringContaining("worktree.changes"))
    })

    it("logs (and drops) a ui-prefs without a string theme", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("ui-prefs", { theme: 42 })
      expect(orch.uiPrefsSignal()()).toBeNull()
      expect(logClientError).toHaveBeenCalledTimes(1)
      expect(logClientError).toHaveBeenCalledWith("orch", expect.stringContaining("ui-prefs"))
    })

    it("logs (and drops) a keybindings without a numeric rev", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("keybindings", { rev: "1" })
      expect(orch.keybindingsRevSignal()()).toBeNull()
      expect(logClientError).toHaveBeenCalledTimes(1)
      expect(logClientError).toHaveBeenCalledWith("orch", expect.stringContaining("keybindings"))
    })

    it("keeps the happy path silent — a well-formed event logs nothing", () => {
      const { client, emit } = fakeClient()
      const orch = new RemoteOrchestrator(client)
      emit("active-task", { taskId: "t1" })
      emit("ui-prefs", { theme: "nord" })
      emit("keybindings", { rev: 3 })
      expect(logClientError).not.toHaveBeenCalled()
    })
  })
})

describe("worktree.changes capability gating (init)", () => {
  function fakeRpcClient(hello: Record<string, unknown>) {
    let star: ((frame: { name: string; payload: unknown }) => void) | undefined
    const client = {
      on: (name: string, handler: (frame: { name: string; payload: unknown }) => void) => {
        if (name === "*") star = handler
        return () => {}
      },
      onLifecycle: () => () => {},
      request: async (name: string) => (name === "hello" ? hello : {}),
      subscribe: async () => ({}),
    } as unknown as KobeDaemonClient
    return { client, emit: (name: string, payload: unknown) => star?.({ name, payload }) }
  }

  it("a capable daemon yields an empty map (trust pushes) before any publish", async () => {
    const { client } = fakeRpcClient({ protocolVersion: 3, capabilities: ["task.snapshot", "worktree.changes"] })
    const orch = new RemoteOrchestrator(client)
    await orch.init()
    expect(orch.worktreeChangesSignal()()?.size).toBe(0)
  })

  it("a capability-less (old) daemon resets the signal to null — fallback engages", async () => {
    const { client, emit } = fakeRpcClient({ protocolVersion: 3, capabilities: ["task.snapshot"] })
    const orch = new RemoteOrchestrator(client)
    emit("worktree.changes", { changes: { "/wt/a": { added: 1, deleted: 0 } } })
    await orch.init()
    expect(orch.worktreeChangesSignal()()).toBeNull()
  })

  it("a replayed map delivered during subscribe is not clobbered by init", async () => {
    const { client, emit } = fakeRpcClient({ protocolVersion: 3, capabilities: ["worktree.changes"] })
    const orch = new RemoteOrchestrator(client)
    emit("worktree.changes", { changes: { "/wt/a": { added: 4, deleted: 2 } } })
    await orch.init()
    expect(orch.worktreeChangesSignal()()?.get("/wt/a")).toEqual({ added: 4, deleted: 2 })
  })
})

describe("decodeUiPrefsPayload — backward-compat defaults", () => {
  it("drops a payload with no theme string", () => {
    expect(decodeUiPrefsPayload(undefined)).toBeNull()
    expect(decodeUiPrefsPayload({})).toBeNull()
    expect(decodeUiPrefsPayload({ theme: 42 })).toBeNull()
  })

  it("an older daemon's theme-only payload resolves every newer field to its absent-sentinel", () => {
    expect(decodeUiPrefsPayload({ theme: "claude" })).toEqual({
      theme: "claude",
      transparentBackground: false,
      focusAccent: null,
      locale: "",
      sortMode: "default",
      keysCollapsed: false,
      projectFilter: null,
    })
  })

  it("carries real values through and normalizes odd ones", () => {
    expect(
      decodeUiPrefsPayload({ theme: "tokyonight", locale: "zh-CN", sortMode: "recent", keysCollapsed: true }),
    ).toEqual({
      theme: "tokyonight",
      transparentBackground: false,
      focusAccent: null,
      locale: "zh-CN",
      sortMode: "recent",
      keysCollapsed: true,
      projectFilter: null,
    })
    const d = decodeUiPrefsPayload({ theme: "x", projectFilter: "", sortMode: "weird", focusAccent: "#abc" })
    expect(d?.projectFilter).toBeNull()
    expect(d?.sortMode).toBe("default")
    expect(d?.focusAccent).toBe("#abc")
  })
})

describe("worktree.changes pure helpers", () => {
  it("parseWorktreeChangesPayload accepts an empty map and rejects malformed entries", () => {
    expect(parseWorktreeChangesPayload({ changes: {} })?.size).toBe(0)
    expect(parseWorktreeChangesPayload(undefined)).toBeNull()
    expect(parseWorktreeChangesPayload({ changes: [] })).toBeNull()
    expect(parseWorktreeChangesPayload({ changes: { "/wt": { added: 1 } } })).toBeNull()
  })

  it("sameWorktreeChangesMap compares entry-wise", () => {
    const a = new Map([["/wt", { added: 1, deleted: 2 }]])
    expect(sameWorktreeChangesMap(a, new Map([["/wt", { added: 1, deleted: 2 }]]))).toBe(true)
    expect(sameWorktreeChangesMap(a, new Map([["/wt", { added: 1, deleted: 3 }]]))).toBe(false)
    expect(sameWorktreeChangesMap(a, new Map())).toBe(false)
  })
})

describe("framework-free store twins (React hosts, issue #15 G3)", () => {
  it("ui-prefs channel lands in uiPrefsStore and notifies subscribers", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    const store = orch.uiPrefsStore()
    const seen: Array<string | undefined> = []
    const unsub = store.subscribe(() => seen.push(store.get()?.theme))
    emit("ui-prefs", { theme: "nord" })
    expect(store.get()?.theme).toBe("nord")
    expect(orch.uiPrefsSignal()()?.theme).toBe("nord")
    emit("ui-prefs", { theme: "claude" })
    unsub()
    emit("ui-prefs", { theme: "dracula" })
    expect(seen).toEqual(["nord", "claude"])
    expect(store.get()?.theme).toBe("dracula")
  })

  it("keybindings channel lands in keybindingsRevStore and notifies", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    const store = orch.keybindingsRevStore()
    const seen: Array<number | null> = []
    store.subscribe(() => seen.push(store.get()))
    emit("keybindings", { rev: 1 })
    emit("keybindings", { rev: 2 })
    expect(seen).toEqual([1, 2])
  })
})
