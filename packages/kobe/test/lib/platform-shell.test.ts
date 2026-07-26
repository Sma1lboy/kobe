import { resolveLoginShell, toPosixPath } from "@sma1lboy/kobe-daemon/daemon/platform-shell"
import { describe, expect, test } from "vitest"

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe"

describe("resolveLoginShell", () => {
  test("POSIX keeps $SHELL, and each call site keeps its own historical fallback", () => {
    const env = { SHELL: "/usr/local/bin/fish" }
    expect(resolveLoginShell({ platform: "darwin", env })).toBe("/usr/local/bin/fish")
    expect(resolveLoginShell({ platform: "darwin", env: {}, fallback: "/bin/zsh" })).toBe("/bin/zsh")
    expect(resolveLoginShell({ platform: "linux", env: {} })).toBe("/bin/bash")
  })

  test("POSIX ignores a blank $SHELL rather than spawning an empty argv0", () => {
    expect(resolveLoginShell({ platform: "linux", env: { SHELL: "   " }, fallback: "/bin/zsh" })).toBe("/bin/zsh")
  })

  test("Windows resolves Git for Windows bash, never the POSIX fallback", () => {
    const shell = resolveLoginShell({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      fallback: "/bin/zsh",
    })
    expect(shell).toBe(GIT_BASH)
  })

  test("Windows ignores an MSYS $SHELL the Windows process API cannot spawn", () => {
    // Inherited from a Git Bash parent: `/usr/bin/bash` is not a real Windows
    // path, so honouring it would make every PTY spawn fail.
    const shell = resolveLoginShell({
      platform: "win32",
      env: { SHELL: "/usr/bin/bash", ProgramFiles: "C:\\Program Files" },
    })
    expect(shell).toBe(GIT_BASH)
  })

  test("Windows names the expected Git bash path when nothing is installed", () => {
    // Not bare `bash.exe` — that resolves to System32's WSL launcher, which
    // would open a Linux filesystem with no view of the Windows worktree.
    expect(resolveLoginShell({ platform: "win32", env: {} })).toBe(GIT_BASH)
  })
})

describe("toPosixPath", () => {
  test("is identity on POSIX", () => {
    expect(toPosixPath("/repo/.worktrees/task-1", "darwin")).toBe("/repo/.worktrees/task-1")
  })

  test("rewrites a Windows path to the MSYS form Git Bash reads", () => {
    expect(toPosixPath("C:\\Users\\dev\\.kobe\\worktree-init\\ab12", "win32")).toBe(
      "/c/Users/dev/.kobe/worktree-init/ab12",
    )
  })

  test("handles a UNC-free relative path and an already-posix path", () => {
    expect(toPosixPath(".kobe\\init.sh", "win32")).toBe(".kobe/init.sh")
    expect(toPosixPath("/c/already/posix", "win32")).toBe("/c/already/posix")
  })
})
