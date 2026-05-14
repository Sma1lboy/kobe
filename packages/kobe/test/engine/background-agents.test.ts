import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildBackgroundAgentArgs,
  listBackgroundAgentsForCwd,
  normalizeBackgroundAgent,
} from "@/engine/claude-code-local/background-agents"
import { describe, expect, it } from "vitest"

describe("normalizeBackgroundAgent", () => {
  it("keeps only Claude background session rows", () => {
    expect(normalizeBackgroundAgent({ kind: "interactive", sessionId: "s", cwd: "/repo" })).toBeNull()
    expect(
      normalizeBackgroundAgent({
        kind: "bg",
        sessionId: "session-1",
        cwd: "/repo",
        jobId: "job-1",
        name: "fix auth",
        status: "needs_input",
        agent: "claude",
        pid: 123,
        version: "2.1.141",
        startedAt: 10,
        updatedAt: 20,
      }),
    ).toEqual({
      id: "job-1",
      sessionId: "session-1",
      name: "fix auth",
      status: "blocked",
      sourceStatus: "needs_input",
      cwd: "/repo",
      agent: "claude",
      jobId: "job-1",
      pid: 123,
      version: "2.1.141",
      startedAtMs: 10,
      updatedAtMs: 20,
    })
  })
})

describe("listBackgroundAgentsForCwd", () => {
  it("lists bg sessions under cwd newest first", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kobe-bg-agents-"))
    mkdirSync(root, { recursive: true })
    writeFileSync(
      path.join(root, "one.json"),
      JSON.stringify({
        kind: "bg",
        sessionId: "session-old",
        cwd: "/repo/worktree",
        name: "old",
        status: "idle",
        updatedAt: 10,
      }),
    )
    writeFileSync(
      path.join(root, "two.json"),
      JSON.stringify({
        kind: "bg",
        sessionId: "session-new",
        cwd: "/repo/worktree/nested",
        name: "new",
        status: "running",
        updatedAt: 20,
      }),
    )
    writeFileSync(
      path.join(root, "outside.json"),
      JSON.stringify({ kind: "bg", sessionId: "outside", cwd: "/other", status: "running", updatedAt: 30 }),
    )
    writeFileSync(
      path.join(root, "interactive.json"),
      JSON.stringify({ kind: "interactive", sessionId: "i", cwd: "/repo" }),
    )

    const out = await listBackgroundAgentsForCwd("/repo/worktree", {
      sessionsDir: () => root,
      readdir: async (p) => (await import("node:fs/promises")).readdir(p),
      readFile: async (p) => (await import("node:fs/promises")).readFile(p, "utf8"),
    })

    expect(out.map((agent) => agent.sessionId)).toEqual(["session-new", "session-old"])
    expect(out.map((agent) => agent.status)).toEqual(["running", "idle"])
  })
})

describe("buildBackgroundAgentArgs", () => {
  it("omits permission mode when the adapter leaves Claude's background default in place", () => {
    const prevMcpConfig = process.env.KOBE_MCP_CONFIG
    process.env.KOBE_MCP_CONFIG = ""
    try {
      expect(
        buildBackgroundAgentArgs({
          binaryPath: "/bin/claude",
          cwd: "/repo",
          prompt: "fix checkout flow",
          model: "opus-4.6",
        }),
      ).toEqual(["--bg", "fix checkout flow", "--model", "opus-4.6"])
    } finally {
      if (prevMcpConfig === undefined) process.env.KOBE_MCP_CONFIG = ""
      else process.env.KOBE_MCP_CONFIG = prevMcpConfig
    }
  })

  it("uses Claude Code's background-agent entrypoint with model and permission options", () => {
    const prevMcpConfig = process.env.KOBE_MCP_CONFIG
    process.env.KOBE_MCP_CONFIG = ""
    try {
      expect(
        buildBackgroundAgentArgs({
          binaryPath: "/bin/claude",
          cwd: "/repo",
          prompt: "fix checkout flow",
          model: "opus-4.6",
          modelEffort: "high",
          permissionMode: "bypassPermissions",
        }),
      ).toEqual([
        "--bg",
        "fix checkout flow",
        "--model",
        "opus-4.6",
        "--effort",
        "high",
        "--permission-mode",
        "bypassPermissions",
      ])
    } finally {
      if (prevMcpConfig === undefined) process.env.KOBE_MCP_CONFIG = ""
      else process.env.KOBE_MCP_CONFIG = prevMcpConfig
    }
  })
})
