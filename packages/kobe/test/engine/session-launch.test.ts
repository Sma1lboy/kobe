import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { buildEngineSessionLaunch, engineSessionKey } from "../../src/engine/session-launch.ts"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeWorktree(files: Record<string, string>): string {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-session-launch-"))
  tempDirs.push(worktree)
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(worktree, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return worktree
}

describe("hosted engine session launch", () => {
  test("uses the first engine tab as the canonical task session key", () => {
    expect(engineSessionKey("task-1")).toBe("task-1::tab-1")
  })

  test("builds an interactive shell launch with the explicit first prompt", () => {
    const launch = buildEngineSessionLaunch({
      task: { id: "task-1", kind: "task", vendor: "claude", repo: "/repo" },
      worktreePath: "/repo/.worktrees/task-1",
      shell: "/bin/zsh",
      argv: ["claude"],
      promptIntent: { kind: "explicit", prompt: "fix it" },
      protocolGates: { status: () => false, notes: () => false, dispatcher: () => false },
    })

    expect(launch.key).toBe("task-1::tab-1")
    expect(launch.command.slice(0, 2)).toEqual(["/bin/zsh", "-ilc"])
    expect(launch.command[2]).toContain("claude 'fix it'")
    expect(launch.command[2]).toContain('exec "${SHELL:-/bin/sh}"')
  })

  test("is owned by the engine layer without importing the retiring tmux runtime", () => {
    const source = fs.readFileSync(new URL("../../src/engine/session-launch.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/from ["'][^"']*tmux/)
  })

  test("runs marker-gated repo init before the repo first message", () => {
    const worktree = makeWorktree({
      ".kobe/init.sh": "export READY=1",
      ".kobe/init-prompt.md": "read the repo docs",
    })
    const launch = buildEngineSessionLaunch({
      task: { id: "task-1", kind: "task", vendor: "claude", repo: worktree },
      worktreePath: worktree,
      shell: "/bin/zsh",
      argv: ["claude"],
      promptIntent: { kind: "repo-init" },
      initTimeoutSeconds: 7,
      protocolGates: { status: () => false, notes: () => false, dispatcher: () => false },
    })
    const script = launch.command[2]

    expect(script).toContain("sh .kobe/init.sh")
    expect(script).toContain("sleep 7;")
    expect(script).toContain("worktree-init")
    expect(script.indexOf("sh .kobe/init.sh")).toBeLessThan(script.indexOf("claude 'read the repo docs'"))
  })

  test("injects the worktree protocol only for regular tasks", () => {
    const regular = buildEngineSessionLaunch({
      task: { id: "task-1", kind: "task", vendor: "claude" },
      worktreePath: "/worktree",
      shell: "/bin/zsh",
      argv: ["claude"],
      promptIntent: { kind: "none" },
      protocolGates: { status: () => true, notes: () => false, dispatcher: () => true },
    })
    const main = buildEngineSessionLaunch({
      task: { id: "main-1", kind: "main", vendor: "claude" },
      worktreePath: "/repo",
      shell: "/bin/zsh",
      argv: ["claude"],
      promptIntent: { kind: "none" },
      protocolGates: { status: () => true, notes: () => false, dispatcher: () => true },
    })

    expect(regular.command[2]).toContain("report it by running")
    expect(regular.command[2]).not.toContain("DISPATCHER")
    expect(main.command[2]).toContain("DISPATCHER")
    expect(main.command[2]).not.toContain("report it by running")
  })
})
