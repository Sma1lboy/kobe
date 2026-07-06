/**
 * Behavioral tests for the IO half of editor-launch.ts that
 * `editor-launch.test.ts` leaves out (that file only covers the pure
 * command builders). `Bun.spawn` is stubbed with a tiny fake that only
 * needs to answer `.exited` — both `binaryAvailable` (a `command -v` probe)
 * and `fileHasDiff` (`git diff --quiet`) only ever read the exit code, never
 * stdout/stderr — so this is a much smaller surface to fake than the tmux
 * client's spawns. `getPersistedString` (state/repos) is mocked so
 * `resolveEditorCommand` doesn't touch a real state.json.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  persisted: {} as Record<string, string | undefined>,
  binaryExitCode: 0, // `sh -c "command -v …"` exit code
  diffExitCode: 1, // `git diff --quiet` exit code (1 = has a diff)
  newWindowCalls: [] as Array<{ session: string; opts: Record<string, unknown> }>,
}))

vi.mock("../../src/state/repos", () => ({
  getPersistedString: (key: string) => state.persisted[key],
}))
vi.mock("../../src/lib/git-env", () => ({ readOnlyGitProcessEnv: () => ({}) }))
vi.mock("../../src/tmux/client", () => ({
  newWindow: vi.fn(async (session: string, opts: Record<string, unknown>) => {
    state.newWindowCalls.push({ session, opts })
  }),
}))

const editorLaunch = await import("../../src/tmux/editor-launch")
const client = await import("../../src/tmux/client")

let prevVisual: string | undefined
let prevEditor: string | undefined

function resetState(): void {
  state.persisted = {}
  state.binaryExitCode = 0
  state.diffExitCode = 1
  state.newWindowCalls = []
}

beforeEach(() => {
  resetState()
  vi.clearAllMocks()
  prevVisual = process.env.VISUAL
  prevEditor = process.env.EDITOR
  Reflect.deleteProperty(process.env, "VISUAL")
  Reflect.deleteProperty(process.env, "EDITOR")
  vi.stubGlobal("Bun", {
    spawn: (cmd: string[]) => {
      if (cmd[0] === "sh") return { exited: Promise.resolve(state.binaryExitCode) }
      if (cmd[0] === "git") return { exited: Promise.resolve(state.diffExitCode) }
      return { exited: Promise.resolve(1) }
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  if (prevVisual === undefined) Reflect.deleteProperty(process.env, "VISUAL")
  else process.env.VISUAL = prevVisual
  if (prevEditor === undefined) Reflect.deleteProperty(process.env, "EDITOR")
  else process.env.EDITOR = prevEditor
})

describe("binaryAvailable", () => {
  test("true when `command -v` exits 0", async () => {
    state.binaryExitCode = 0
    await expect(editorLaunch.binaryAvailable("vim")).resolves.toBe(true)
  })

  test("false when the binary isn't found", async () => {
    state.binaryExitCode = 1
    await expect(editorLaunch.binaryAvailable("nope")).resolves.toBe(false)
  })

  test("degrades to false if spawn itself throws", async () => {
    vi.stubGlobal("Bun", {
      spawn: () => {
        throw new Error("boom")
      },
    })
    await expect(editorLaunch.binaryAvailable("vim")).resolves.toBe(false)
  })
})

describe("fileHasDiff", () => {
  test("true only on exit code 1 (git diff --quiet found a diff)", async () => {
    state.diffExitCode = 1
    await expect(editorLaunch.fileHasDiff("/wt", "a.ts")).resolves.toBe(true)
  })

  test("false when the file matches HEAD (exit 0) or errors (other codes)", async () => {
    state.diffExitCode = 0
    await expect(editorLaunch.fileHasDiff("/wt", "a.ts")).resolves.toBe(false)
    state.diffExitCode = 128
    await expect(editorLaunch.fileHasDiff("/wt", "a.ts")).resolves.toBe(false)
  })

  test("degrades to false if spawn itself throws", async () => {
    vi.stubGlobal("Bun", {
      spawn: () => {
        throw new Error("boom")
      },
    })
    await expect(editorLaunch.fileHasDiff("/wt", "a.ts")).resolves.toBe(false)
  })
})

describe("resolveEditorCommand", () => {
  test("an explicit kind resolves synchronously, ignoring env/auto-probe", async () => {
    state.persisted["editor.kind"] = "nano"
    await expect(editorLaunch.resolveEditorCommand("/wt/a.ts")).resolves.toEqual({
      bin: "nano",
      command: "nano '/wt/a.ts'",
    })
  })

  test("auto prefers $VISUAL over $EDITOR over probing", async () => {
    state.persisted["editor.kind"] = "auto"
    process.env.VISUAL = "code -w {file}"
    process.env.EDITOR = "nano"
    await expect(editorLaunch.resolveEditorCommand("/wt/a.ts")).resolves.toEqual({
      bin: "code",
      command: "code -w '/wt/a.ts'",
    })
  })

  test("auto with no env falls back to probing AUTO_EDITOR_CANDIDATES in order", async () => {
    state.persisted["editor.kind"] = "auto"
    state.binaryExitCode = 0 // every candidate "found" — first one (nvim) wins
    await expect(editorLaunch.resolveEditorCommand("/wt/a.ts")).resolves.toEqual({
      bin: "nvim",
      command: "nvim '/wt/a.ts'",
    })
  })

  test("auto with nothing installed returns null (caller falls back to preview)", async () => {
    state.persisted["editor.kind"] = "auto"
    state.binaryExitCode = 1
    await expect(editorLaunch.resolveEditorCommand("/wt/a.ts")).resolves.toBeNull()
  })

  test("custom kind reads the persisted custom command", async () => {
    state.persisted["editor.kind"] = "custom"
    state.persisted["editor.customCommand"] = "subl -w {file}"
    await expect(editorLaunch.resolveEditorCommand("/wt/a.ts")).resolves.toEqual({
      bin: "subl",
      command: "subl -w '/wt/a.ts'",
    })
  })
})

describe("openInEditor", () => {
  test("returns false and opens nothing when no editor resolves", async () => {
    state.persisted["editor.kind"] = "auto"
    state.binaryExitCode = 1
    await expect(editorLaunch.openInEditor("kobe-t1", "/wt", "/wt/a.ts")).resolves.toBe(false)
    expect(state.newWindowCalls).toEqual([])
  })

  test("returns false when the resolved editor's binary isn't actually on PATH", async () => {
    state.persisted["editor.kind"] = "vim"
    state.binaryExitCode = 1 // resolveEditorCommand doesn't probe for "vim" kind, but openInEditor's own pre-flight does
    await expect(editorLaunch.openInEditor("kobe-t1", "/wt", "/wt/a.ts")).resolves.toBe(false)
    expect(state.newWindowCalls).toEqual([])
  })

  test("opens a plain editor window named after the file", async () => {
    state.persisted["editor.kind"] = "nano"
    state.binaryExitCode = 0
    await expect(editorLaunch.openInEditor("kobe-t1", "/wt", "/wt/src/a.ts")).resolves.toBe(true)
    expect(state.newWindowCalls).toEqual([
      { session: "kobe-t1", opts: { cwd: "/wt", command: "nano '/wt/src/a.ts'", name: "a.ts" } },
    ])
  })

  test("upgrades a plain vim/nvim open to diff mode when the file differs from HEAD", async () => {
    state.persisted["editor.kind"] = "nvim"
    state.binaryExitCode = 0
    state.diffExitCode = 1
    await editorLaunch.openInEditor("kobe-t1", "/wt", "/wt/src/a.ts")
    expect(state.newWindowCalls).toHaveLength(1)
    const command = state.newWindowCalls[0]?.opts.command as string
    expect(command).toContain("nvim -d")
    expect(command).toContain("src/a.ts")
  })

  test("does not upgrade to diff mode for a file outside the worktree or with no diff", async () => {
    state.persisted["editor.kind"] = "nvim"
    state.binaryExitCode = 0
    state.diffExitCode = 0 // no diff from HEAD
    await editorLaunch.openInEditor("kobe-t1", "/wt", "/wt/src/a.ts")
    expect(state.newWindowCalls[0]?.opts.command).toBe("nvim '/wt/src/a.ts'")
  })

  test("never rewrites a custom command with its own flags, even for nvim", async () => {
    state.persisted["editor.kind"] = "custom"
    state.persisted["editor.customCommand"] = "nvim -u NONE {file}"
    state.binaryExitCode = 0
    state.diffExitCode = 1
    await editorLaunch.openInEditor("kobe-t1", "/wt", "/wt/src/a.ts")
    expect(state.newWindowCalls[0]?.opts.command).toBe("nvim -u NONE '/wt/src/a.ts'")
  })
})
