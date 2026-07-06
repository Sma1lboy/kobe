import { describe, expect, it } from "vitest"
import type { ExecHost, ExecResult } from "../../src/exec/exec-host.ts"
import { GitWorktreeManager, type WorktreeExecDeps } from "../../src/orchestrator/worktree/manager.ts"

const BASE = "/srv/work"
const REMOTE_KEY = "ssh://dev@box:2222"

/** A fake ExecHost that scripts git output and records every argv + cwd. */
function fakeRemote(script: (argv: readonly string[]) => ExecResult) {
  const runs: Array<{ argv: readonly string[]; cwd?: string }> = []
  const exec: ExecHost = {
    isRemote: true,
    async run(argv, opts) {
      runs.push({ argv, cwd: opts?.cwd })
      return script(argv)
    },
    exists: async () => false,
    mkdirp: async () => {},
    readFile: async () => null,
    readdir: async () => [],
    wrapCommand: (c) => c,
    ensureReady: () => {},
  }
  return { exec, runs }
}

/** Wire the manager so REMOTE_KEY resolves to the fake remote, all else local-ish. */
function remoteDeps(exec: ExecHost): WorktreeExecDeps {
  return {
    execForRepo: () => exec,
    execForPath: () => exec,
    remoteBasePath: (key) => (key === REMOTE_KEY ? BASE : null),
  }
}

describe("GitWorktreeManager — remote project", () => {
  it("creates the worktree under <basePath>/.kobe/worktrees on the remote git dir", async () => {
    const ok: ExecResult = { stdout: "", stderr: "", exitCode: 0 }
    const { exec, runs } = fakeRemote((argv) => {
      // After `worktree add`, tryDescribe lists the porcelain — answer with the entry.
      if (argv.includes("list") && argv.includes("--porcelain")) {
        return {
          stdout: `worktree ${BASE}/.kobe/worktrees/panda\nHEAD abc123\nbranch refs/heads/feat\n\n`,
          stderr: "",
          exitCode: 0,
        }
      }
      if (argv.includes("status")) return ok // isDirty → clean
      if (argv.includes("show-ref")) return { stdout: "", stderr: "", exitCode: 1 } // branch absent → -b
      return ok
    })
    const mgr = new GitWorktreeManager(remoteDeps(exec))

    const info = await mgr.createForTask({ repo: REMOTE_KEY, slug: "panda", branch: "feat" })
    expect(info.path).toBe(`${BASE}/.kobe/worktrees/panda`)
    expect(info.branch).toBe("feat")

    // The `worktree add` ran with cwd = the remote basePath (not the ssh:// key).
    const addRun = runs.find((r) => r.argv.includes("add"))
    expect(addRun?.cwd).toBe(BASE)
    expect(addRun?.argv).toEqual(["git", "worktree", "add", "-b", "feat", `${BASE}/.kobe/worktrees/panda`])
    // Every command went through the (git) ExecHost, prefixed with git.
    expect(runs.every((r) => r.argv[0] === "git")).toBe(true)
  })

  it("list() filters to <basePath>/.kobe/worktrees and skips outside worktrees", async () => {
    const { exec } = fakeRemote((argv) => {
      if (argv.includes("list") && argv.includes("--porcelain")) {
        return {
          stdout: [
            `worktree ${BASE}\nHEAD aaa\nbranch refs/heads/main\n`,
            `worktree ${BASE}/.kobe/worktrees/panda\nHEAD bbb\nbranch refs/heads/feat\n`,
            "worktree /elsewhere/wt\nHEAD ccc\nbranch refs/heads/other\n",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 } // status → clean
    })
    const mgr = new GitWorktreeManager(remoteDeps(exec))
    const infos = await mgr.list(REMOTE_KEY)
    expect(infos.map((i) => i.path)).toEqual([`${BASE}/.kobe/worktrees/panda`])
  })
})
