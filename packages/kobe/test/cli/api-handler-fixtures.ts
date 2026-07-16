import type { ChannelName, ChannelPayloads } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { expect } from "vitest"
import { ApiError, type ApiRuntime, type DeliveredPrompt, type PromptTarget } from "../../src/cli/api-cmd.ts"
import type { DaemonRpc } from "../../src/cli/daemon-session.ts"

type RpcResponder = (payload: unknown, callIndex: number) => unknown

export class FakeClient implements DaemonRpc {
  readonly requests: Array<{ name: string; payload: unknown }> = []
  readonly replay: Array<{ channel: ChannelName; payload: unknown }> = []
  subscribeCount = 0
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>()

  constructor(private readonly responders: Record<string, RpcResponder> = {}) {}

  async request<T = unknown>(name: string, payload?: unknown): Promise<T> {
    const callIndex = this.requests.filter((request) => request.name === name).length
    this.requests.push({ name, payload })
    const respond = this.responders[name]
    if (!respond) throw new Error(`fake daemon has no responder for "${name}"`)
    return respond(payload, callIndex) as T
  }

  async subscribe(): Promise<unknown> {
    this.subscribeCount++
    for (const { channel, payload } of this.replay) {
      for (const handler of this.handlers.get(channel) ?? []) handler(payload)
    }
    return {}
  }

  onChannel<C extends ChannelName>(channel: C, handler: (payload: ChannelPayloads[C]) => void): () => void {
    let handlers = this.handlers.get(channel)
    if (!handlers) {
      handlers = new Set()
      this.handlers.set(channel, handlers)
    }
    const untyped = handler as (payload: unknown) => void
    handlers.add(untyped)
    return () => handlers?.delete(untyped)
  }

  get requestNames(): string[] {
    return this.requests.map((request) => request.name)
  }
}

export function taskFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t1",
    title: "T",
    branch: "kobe/t-t1",
    worktreePath: "/wt/t1",
    vendor: "claude",
    repo: "/repo/x",
    status: "backlog",
    archived: false,
    ...overrides,
  }
}

export function stubRuntime(overrides: Partial<ApiRuntime> = {}): ApiRuntime {
  return {
    isTaskRunning: async () => false,
    deliverPrompt: async () => {
      throw new Error("deliverPrompt should not run in this test")
    },
    resolveRepoRoot: async (path) => path,
    defaultVendor: async () => undefined,
    readWorktreeChanges: async () => ({ added: 0, deleted: 0 }),
    readBranchSignals: async () => ({ baseRef: null, ahead: null, diff: null }),
    tearDownSession: async () => {},
    ...overrides,
  }
}

export function recordingTearDown() {
  const killed: string[] = []
  const tearDownSession: ApiRuntime["tearDownSession"] = async (taskId) => {
    killed.push(taskId)
  }
  return { killed, tearDownSession }
}

export function recordingDelivery(result: Partial<DeliveredPrompt> = {}) {
  const calls: Array<{ target: PromptTarget; prompt: string }> = []
  const deliver: ApiRuntime["deliverPrompt"] = async (_client, target, prompt) => {
    calls.push({ target, prompt })
    return {
      session: `${target.id}::tab-1`,
      pane: `${target.id}::tab-1`,
      started: true,
      engineReady: true,
      delivered: true,
      ...result,
    }
  }
  return { calls, deliver }
}

export async function expectApiError(
  run: () => Promise<unknown>,
  code: string,
  message?: string | RegExp,
): Promise<void> {
  try {
    await run()
    expect.unreachable("should have thrown")
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe(code)
    if (typeof message === "string") expect((error as ApiError).message).toBe(message)
    else if (message) expect((error as ApiError).message).toMatch(message)
  }
}
