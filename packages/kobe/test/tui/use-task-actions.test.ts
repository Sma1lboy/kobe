import { describe, expect, test } from "vitest"
import type { KVContext } from "../../src/tui/context/kv.tsx"
import { initialChatModelConfig } from "../../src/tui/lib/task-model-config.ts"
import type { Task } from "../../src/types/task.ts"

function kvWith(initial: Record<string, unknown> = {}): KVContext {
  const store = { ...initial }
  return {
    get: (key: string, defaultValue?: unknown) => store[key] ?? defaultValue,
    set: (key: string, value: unknown) => {
      store[key] = value
    },
  } as KVContext
}

function taskWithActiveTab(overrides: Partial<Task["tabs"][number]>): Task {
  return {
    id: "01TASK" as Task["id"],
    title: "task",
    repo: "/tmp/repo",
    branch: "",
    worktreePath: "",
    sessionId: null,
    tabs: [
      {
        id: "tab-1",
        sessionId: null,
        seq: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
        ...overrides,
      },
    ],
    activeTabId: "tab-1",
    status: "backlog",
    archived: false,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
  }
}

describe("initialChatModelConfig", () => {
  test("reads the current task active chat tab model config and persists it as last active", () => {
    const kv = kvWith()
    const task = taskWithActiveTab({ model: "gpt-5.5", modelEffort: "xhigh", vendor: "codex" })

    expect(initialChatModelConfig(task, kv)).toEqual({
      model: "gpt-5.5",
      modelEffort: "xhigh",
      vendor: "codex",
    })
    expect(kv.get("lastActiveChatModelConfig")).toEqual({
      model: "gpt-5.5",
      modelEffort: "xhigh",
      vendor: "codex",
    })
  })

  test("falls back to the persisted last-active model config when no task is selected", () => {
    const kv = kvWith({
      lastActiveChatModelConfig: {
        model: "opus",
        modelEffort: "max",
        vendor: "claude",
      },
    })

    expect(initialChatModelConfig(undefined, kv)).toEqual({
      model: "opus",
      modelEffort: "max",
      vendor: "claude",
    })
  })

  test("returns an empty config when there is no active or persisted model config", () => {
    expect(initialChatModelConfig(undefined, kvWith())).toEqual({})
  })
})
