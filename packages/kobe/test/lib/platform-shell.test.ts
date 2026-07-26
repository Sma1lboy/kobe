import { resolveLoginShell, toPosixPath } from "@sma1lboy/kobe-daemon/daemon/platform-shell"
import { describe, expect, test } from "vitest"

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe"

/**
 * Every `platform: "win32"` case injects its own disk. Without this the suite
 * reads the HOST filesystem: on Linux CI `/usr/bin/bash` genuinely exists, so
 * an MSYS $SHELL looked spawnable, and the Git-bash cases only passed because
 * every probe returned false and the answer collapsed onto the same fallback
 * string it was asserting.
 */
const diskWith = (...present: string[]) => {
  const set = new Set(present)
  return (path: string) => set.has(path)
}
const EMPTY_DISK = diskWith()

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
      exists: diskWith(GIT_BASH),
    })
    expect(shell).toBe(GIT_BASH)
  })

  test("Windows searches the other Git install roots", () => {
    const perUser = "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"
    const shell = resolveLoginShell({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      exists: diskWith(perUser),
    })
    expect(shell).toBe(perUser)
  })

  test("Windows ignores an MSYS $SHELL the Windows process API cannot spawn", () => {
    // Inherited from a Git Bash parent. CreateProcess cannot resolve
    // `/usr/bin/bash`, so it must be rejected on its SHAPE — a disk that
    // claims it exists (every POSIX CI host) must not change the answer.
    const shell = resolveLoginShell({
      platform: "win32",
      env: { SHELL: "/usr/bin/bash", ProgramFiles: "C:\\Program Files" },
      exists: diskWith("/usr/bin/bash", GIT_BASH),
    })
    expect(shell).toBe(GIT_BASH)
  })

  test("Windows honours a $SHELL that CreateProcess really can launch", () => {
    const custom = "D:\\tools\\msys64\\usr\\bin\\bash.exe"
    const shell = resolveLoginShell({
      platform: "win32",
      env: { SHELL: custom, ProgramFiles: "C:\\Program Files" },
      exists: diskWith(custom, GIT_BASH),
    })
    expect(shell).toBe(custom)
  })

  test("Windows drops a drive-absolute $SHELL that is not actually installed", () => {
    const shell = resolveLoginShell({
      platform: "win32",
      env: { SHELL: "C:\\nope\\bash.exe", ProgramFiles: "C:\\Program Files" },
      exists: diskWith(GIT_BASH),
    })
    expect(shell).toBe(GIT_BASH)
  })

  test("Windows names the expected Git bash path when nothing is installed", () => {
    // Not bare `bash.exe` — that resolves to System32's WSL launcher, which
    // would open a Linux filesystem with no view of the Windows worktree.
    expect(resolveLoginShell({ platform: "win32", env: {}, exists: EMPTY_DISK })).toBe(GIT_BASH)
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
