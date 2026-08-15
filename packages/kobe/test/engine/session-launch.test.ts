import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { buildEngineSessionLaunch, engineLaunchLine, engineSessionKey } from "../../src/engine/session-launch.ts"

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
    expect(launch.command[2]).toContain("ROVE_TASK_ID='task-1' KOBE_TASK_ID='task-1'")
    expect(launch.command[2]).toContain("ROVE_TAB_ID='tab-1' KOBE_TAB_ID='tab-1'")
    expect(launch.command[2]).toContain('exec "${SHELL:-/bin/sh}"')
  })

  test("new-task intent bakes the launch task's id into the branch-rename coda", () => {
    const launch = buildEngineSessionLaunch({
      task: { id: "task-9", kind: "task", vendor: "claude", repo: "/repo" },
      worktreePath: "/repo/.worktrees/task-9",
      shell: "/bin/zsh",
      argv: ["claude"],
      promptIntent: { kind: "new-task", prompt: "fix it" },
      protocolGates: { status: () => false, notes: () => false, dispatcher: () => false },
    })
    expect(launch.command[2]).toContain("fix it")
    expect(launch.command[2]).toContain("set-branch --task-id task-9")
  })

  test("keeps a paste vendor's first message OUT of the argv and hands it to the spawner (issue #25)", () => {
    const launch = buildEngineSessionLaunch({
      task: { id: "task-1", kind: "task", vendor: "kimi", repo: "/repo" },
      worktreePath: "/repo/.worktrees/task-1",
      shell: "/bin/zsh",
      argv: ["kimi", "-y"],
      promptIntent: { kind: "explicit", prompt: "fix it" },
      protocolGates: { status: () => false, notes: () => false, dispatcher: () => false },
    })

    // kimi's positional CLI slot is a subcommand — a prompt there exits the
    // engine with "Unknown command". The spawner pastes it post-spawn.
    expect(launch.command[2]).not.toContain("fix it")
    expect(launch.firstMessage).toBe("fix it")
  })

  test("an explicit argv override keeps the prompt on the launch line even for a paste vendor", () => {
    // The TUI owns no post-spawn paste hook yet, so it pins "argv" —
    // dropping the prompt silently would be worse than the engine's loud
    // unknown-command exit.
    const launch = buildEngineSessionLaunch({
      task: { id: "task-1", kind: "task", vendor: "kimi", repo: "/repo" },
      worktreePath: "/repo/.worktrees/task-1",
      shell: "/bin/zsh",
      argv: ["kimi"],
      promptIntent: { kind: "explicit", prompt: "fix it" },
      firstMessageDelivery: "argv",
      protocolGates: { status: () => false, notes: () => false, dispatcher: () => false },
    })

    expect(launch.command[2]).toContain("kimi 'fix it'")
    expect(launch.firstMessage).toBeUndefined()
  })

  test("is owned by the engine layer without importing the retiring tmux runtime", () => {
    const source = fs.readFileSync(new URL("../../src/engine/session-launch.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/from ["'][^"']*tmux/)
  })

  test("runs marker-gated repo init before the repo first message", () => {
    const worktree = makeWorktree({
      ".rove/init.sh": "export READY=1",
      ".rove/init-prompt.md": "read the repo docs",
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

    expect(script).toContain("sh .rove/init.sh")
    expect(script).toContain("sleep 7;")
    expect(script).toContain("worktree-init")
    expect(script.indexOf("sh .rove/init.sh")).toBeLessThan(script.indexOf("claude 'read the repo docs'"))
  })

  test("writes the init marker in the form the shell reads, not the OS's", () => {
    // The marker is interpolated into a POSIX script that Git Bash runs.
    // `[ -f 'C:\wt\.kobe\worktree-init\ab12' ]` reads `\w` as an escape, so
    // the gate would never match and repo init would re-run on every launch.
    const script = engineLaunchLine("claude", {
      initScript: "echo hi",
      markerPath: "C:\\wt\\.kobe\\worktree-init\\ab12",
      platform: "win32",
    })

    expect(script).toContain("[ ! -f '/c/wt/.kobe/worktree-init/ab12' ]")
    expect(script).toContain("mkdir -p '/c/wt/.kobe/worktree-init'")
    expect(script).not.toContain("\\wt\\")
  })

  test("leaves a POSIX marker path exactly as it is", () => {
    const script = engineLaunchLine("claude", {
      initScript: "echo hi",
      markerPath: "/repo/.kobe/worktree-init/ab12",
      platform: "linux",
    })

    expect(script).toContain("[ ! -f '/repo/.kobe/worktree-init/ab12' ]")
    expect(script).toContain("mkdir -p '/repo/.kobe/worktree-init'")
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

  test("seeds a worktree session with the repo's field notes, and never the main session", () => {
    // The main session is the dispatcher — it gets notes pushed to it live,
    // so reading the store for it would double-deliver.
    const readNotes = (repoRoot: string) => {
      seen.push(repoRoot)
      return [{ text: "build needs --no-sandbox", author: "worker A" }]
    }
    const seen: string[] = []
    const card = buildEngineSessionLaunch({
      task: { id: "task-1", kind: "task", vendor: "claude", repo: "/repo" },
      worktreePath: "/worktree",
      shell: "/bin/zsh",
      argv: ["claude"],
      promptIntent: { kind: "none" },
      protocolGates: { status: () => false, notes: () => true, dispatcher: () => false },
      readNotes,
    })
    const main = buildEngineSessionLaunch({
      task: { id: "main-1", kind: "main", vendor: "claude", repo: "/repo" },
      worktreePath: "/repo",
      shell: "/bin/zsh",
      argv: ["claude"],
      promptIntent: { kind: "none" },
      protocolGates: { status: () => false, notes: () => true, dispatcher: () => true },
      readNotes,
    })

    expect(card.command[2]).toContain("build needs --no-sandbox")
    expect(main.command[2]).not.toContain("build needs --no-sandbox")
    // Read once, for the card only — keyed by the task's source repo.
    expect(seen).toEqual(["/repo"])
  })
})
