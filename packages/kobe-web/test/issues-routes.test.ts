import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { describe, expect, it } from "vitest"
import { handleIssuesRequest } from "../server/issues-route.ts"

interface Call {
  name: DaemonRequestName
  payload: unknown
}

function link(result: unknown = { repoRoot: "/repo", exists: true, nextId: 2, issues: [] }) {
  const calls: Call[] = []
  return {
    calls,
    async request<T>(name: DaemonRequestName, payload?: unknown): Promise<T> {
      calls.push({ name, payload })
      return result as T
    },
  }
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("/api/issues daemon proxy route", () => {
  it("GET proxies to issue.list", async () => {
    const l = link({ repoRoot: "/repo", exists: false, nextId: 1, issues: [] })
    const url = new URL("http://localhost/api/issues?repoRoot=%2Frepo")
    const res = await handleIssuesRequest(new Request(url), url, l)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ repoRoot: "/repo", exists: false, nextId: 1, issues: [] })
    expect(l.calls).toEqual([{ name: "issue.list", payload: { repoRoot: "/repo" } }])
  })

  it("POST proxies to issue.mutate", async () => {
    const l = link()
    const body = { repoRoot: "/repo", op: { type: "create", title: "Ship it" } }
    const url = new URL("http://localhost/api/issues")
    const res = await handleIssuesRequest(post(body), url, l)
    expect(res?.status).toBe(200)
    expect(l.calls).toEqual([{ name: "issue.mutate", payload: body }])
  })

  it("rejects missing repoRoot before touching the daemon", async () => {
    const l = link()
    const url = new URL("http://localhost/api/issues")
    const res = await handleIssuesRequest(post({ op: { type: "create", title: "x" } }), url, l)
    expect(res?.status).toBe(400)
    expect(l.calls).toEqual([])
  })

  it("does not expose the removed worktree sync route", async () => {
    const l = link()
    const url = new URL("http://localhost/api/issues/sync-worktree")
    expect(await handleIssuesRequest(post({}), url, l)).toBeNull()
    expect(l.calls).toEqual([])
  })
})
