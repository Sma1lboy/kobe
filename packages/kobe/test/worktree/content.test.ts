import { describe, expect, it } from "vitest"
import type { ExecHost, ExecResult } from "../../src/exec/exec-host.ts"
import { readWorktreeFile, runWorktreeGit } from "../../src/worktree/content.ts"

function fakeExecHost(result: ExecResult = { stdout: "", stderr: "", exitCode: 0 }) {
  const runs: Array<{
    argv: readonly string[]
    cwd?: string
    env?: Readonly<Record<string, string>>
  }> = []
  const reads: string[] = []
  const exec: ExecHost = {
    isRemote: true,
    async run(argv, opts) {
      runs.push({ argv, cwd: opts?.cwd, env: opts?.env })
      return result
    },
    exists: async () => false,
    existsSync: () => false,
    mkdirp: async () => {},
    readFile: async (path) => {
      reads.push(path)
      return `file:${path}`
    },
    readdir: async () => [],
    wrapCommand: (command) => command,
    ensureReady: () => {},
  }
  return { exec, runs, reads }
}

describe("runWorktreeGit", () => {
  it("runs git through the Worktree's ExecHost with lock-free read env", async () => {
    const { exec, runs } = fakeExecHost({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    })

    const out = await runWorktreeGit("/srv/wt", ["status", "--porcelain"], {
      execForPath: () => exec,
    })

    expect(out).toEqual({ stdout: "ok", stderr: "", status: 0 })
    expect(runs).toEqual([
      {
        argv: ["git", "status", "--porcelain"],
        cwd: "/srv/wt",
        env: { GIT_OPTIONAL_LOCKS: "0" },
      },
    ])
  })

  it("returns a failure result for an empty Worktree path", async () => {
    const { exec, runs } = fakeExecHost()

    await expect(runWorktreeGit("", ["status"], { execForPath: () => exec })).resolves.toEqual({
      stdout: "",
      stderr: "worktreePath is required",
      status: -1,
    })
    expect(runs).toEqual([])
  })

  it("aborts a slow git run when timeoutMs expires", async () => {
    const exec: ExecHost = {
      isRemote: true,
      async run(_argv, opts) {
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          })
        })
        return { stdout: "", stderr: "", exitCode: -1 }
      },
      exists: async () => false,
      existsSync: () => false,
      mkdirp: async () => {},
      readFile: async () => null,
      readdir: async () => [],
      wrapCommand: (command) => command,
      ensureReady: () => {},
    }

    await expect(
      runWorktreeGit("/srv/wt", ["status"], {
        execForPath: () => exec,
        timeoutMs: 1,
      }),
    ).resolves.toEqual({
      stdout: "",
      stderr: "git status timed out after 1ms",
      status: -1,
    })
  })

  it("returns a failure result when the ExecHost run rejects", async () => {
    const exec: ExecHost = {
      isRemote: true,
      run: async () => {
        throw new Error("ssh failed")
      },
      exists: async () => false,
      existsSync: () => false,
      mkdirp: async () => {},
      readFile: async () => null,
      readdir: async () => [],
      wrapCommand: (command) => command,
      ensureReady: () => {},
    }

    await expect(runWorktreeGit("/srv/wt", ["status"], { execForPath: () => exec })).resolves.toEqual({
      stdout: "",
      stderr: "ssh failed",
      status: -1,
    })
  })
})

describe("readWorktreeFile", () => {
  it("reads a relative path through the Worktree's ExecHost", async () => {
    const { exec, reads } = fakeExecHost()

    const text = await readWorktreeFile("/srv/wt/", "src/app.ts", {
      execForPath: () => exec,
    })

    expect(text).toBe("file:/srv/wt/src/app.ts")
    expect(reads).toEqual(["/srv/wt/src/app.ts"])
  })

  it("rejects absolute and parent-traversal paths before touching the host", async () => {
    const { exec, reads } = fakeExecHost()

    await expect(readWorktreeFile("/srv/wt", "/etc/passwd", { execForPath: () => exec })).resolves.toBeNull()
    await expect(readWorktreeFile("/srv/wt", "../secret", { execForPath: () => exec })).resolves.toBeNull()

    expect(reads).toEqual([])
  })

  it("returns null when the ExecHost read rejects", async () => {
    const exec: ExecHost = {
      isRemote: true,
      run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      exists: async () => false,
      existsSync: () => false,
      mkdirp: async () => {},
      readFile: async () => {
        throw new Error("read failed")
      },
      readdir: async () => [],
      wrapCommand: (command) => command,
      ensureReady: () => {},
    }

    await expect(readWorktreeFile("/srv/wt", "src/app.ts", { execForPath: () => exec })).resolves.toBeNull()
  })
})
