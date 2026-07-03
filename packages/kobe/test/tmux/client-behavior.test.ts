/**
 * Behavioral tests for `src/tmux/client.ts`'s real tmux-invoking functions —
 * `client.test.ts` only covers the pure builders and the "spawn itself
 * throws" degrade path (Bun.spawn isn't defined under vitest's node
 * environment, so every real call there degrades before doing anything).
 * Here `Bun.spawn` is stubbed with a tiny fake tmux that answers based on
 * the subcommand (the 4th argv token, after `tmux -L <socket>`), returning
 * canned stdout as a real ReadableStream (drainText does `new
 * Response(stream).text()`), so the actual PARSING logic in each client
 * function gets exercised — not just its degrade path.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const enterWindowMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("../../src/tui/panes/terminal/tmux", () => ({ enterWindow: enterWindowMock }))
// kobeCliInvocation uses import.meta.resolve, unsupported under vitest's SSR
// transform (same stub the perf-budgets suite uses).
vi.mock("../../src/cli/invocation", () => ({ kobeCliInvocation: () => ["kobe"] }))

type FakeResult = { code: number; stdout?: string; stderr?: string }
type Router = (cmd: string[]) => FakeResult

const state = vi.hoisted(() => ({
  router: ((_cmd: string[]) => ({ code: 0, stdout: "" })) as Router,
}))

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function subcommandOf(cmd: string[]): string {
  return cmd[1] === "-V" ? "-V" : (cmd[3] ?? "")
}

beforeEach(() => {
  state.router = (_cmd) => ({ code: 0, stdout: "" })
  vi.stubGlobal("Bun", {
    spawn: (cmd: string[]) => {
      const { code, stdout = "", stderr = "" } = state.router(cmd)
      return {
        stdout: streamFrom(stdout),
        stderr: streamFrom(stderr),
        exited: Promise.resolve(code),
      }
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const client = await import("../../src/tmux/client")

describe("sessionExists / windowCount / tmuxAvailable", () => {
  test("sessionExists reflects has-session's exit code", async () => {
    state.router = (cmd) => ({ code: subcommandOf(cmd) === "has-session" ? 0 : 1 })
    await expect(client.sessionExists("kobe-t1")).resolves.toBe(true)
    state.router = () => ({ code: 1 })
    await expect(client.sessionExists("kobe-t1")).resolves.toBe(false)
  })

  test("windowCount counts non-blank listed window ids", async () => {
    state.router = (cmd) => (subcommandOf(cmd) === "list-windows" ? { code: 0, stdout: "@1\n@2\n@3\n" } : { code: 1 })
    await expect(client.windowCount("kobe-t1")).resolves.toBe(3)
  })

  test("windowCount is 0 when the listing fails", async () => {
    state.router = () => ({ code: 1 })
    await expect(client.windowCount("kobe-t1")).resolves.toBe(0)
  })

  test("tmuxAvailable is true only when `tmux -V` exits 0", async () => {
    state.router = (cmd) => ({ code: cmd[1] === "-V" ? 0 : 1 })
    await expect(client.tmuxAvailable()).resolves.toBe(true)
    state.router = () => ({ code: 1 })
    await expect(client.tmuxAvailable()).resolves.toBe(false)
  })
})

describe("session / server option reads", () => {
  test("getSessionOption trims the captured value", async () => {
    state.router = (cmd) => (subcommandOf(cmd) === "show-options" ? { code: 0, stdout: "  1  \n" } : { code: 1 })
    await expect(client.getSessionOption("kobe-t1", "@kobe_zen")).resolves.toBe("1")
  })

  test("getSessionOption resolves to '' on a failed read (unset option)", async () => {
    state.router = () => ({ code: 1 })
    await expect(client.getSessionOption("kobe-t1", "@kobe_zen")).resolves.toBe("")
  })

  test("getSessionOptions attributes each `option value` line back to its key", async () => {
    state.router = (cmd) =>
      subcommandOf(cmd) === "show-options" ? { code: 0, stdout: "@kobe_task t1\n@kobe_vendor codex\n" } : { code: 1 }
    await expect(
      client.getSessionOptions("kobe-t1", ["@kobe_task", "@kobe_vendor", "@kobe_worktree"]),
    ).resolves.toEqual({
      "@kobe_task": "t1",
      "@kobe_vendor": "codex",
      "@kobe_worktree": undefined,
    })
  })

  test("getServerOptions parses the -sq listing the same way", async () => {
    state.router = (cmd) =>
      subcommandOf(cmd) === "show-options" ? { code: 0, stdout: "@kobe_tasks_width 40\n" } : { code: 1 }
    await expect(client.getServerOptions(["@kobe_tasks_width", "@kobe_right_width_pct"])).resolves.toEqual({
      "@kobe_tasks_width": "40",
      "@kobe_right_width_pct": undefined,
    })
  })

  test("readLayoutGeometry resolves the batched server options into a clamped geometry", async () => {
    state.router = (cmd) =>
      subcommandOf(cmd) === "show-options"
        ? { code: 0, stdout: "@kobe_tasks_width 40\n@kobe_right_width_pct 35\n@kobe_ops_height_pct 55\n" }
        : { code: 1 }
    await expect(client.readLayoutGeometry()).resolves.toMatchObject({
      tasksWidth: 40,
      rightColumnWidthPct: 35,
      opsHeightPct: 55,
    })
  })

  test("globalTasksPaneWidth reads through readLayoutGeometry", async () => {
    state.router = (cmd) =>
      subcommandOf(cmd) === "show-options" ? { code: 0, stdout: "@kobe_tasks_width 28\n" } : { code: 1 }
    await expect(client.globalTasksPaneWidth()).resolves.toBe(28)
  })
})

describe("pane role lookup", () => {
  test("paneIdByRole finds the first pane tagged with the role", async () => {
    state.router = (cmd) =>
      subcommandOf(cmd) === "list-panes" ? { code: 0, stdout: "%0\t\n%1\tclaude\n%2\ttasks\n" } : { code: 1 }
    await expect(client.paneIdByRole("kobe-t1", "tasks")).resolves.toBe("%2")
    await expect(client.paneIdByRole("kobe-t1", "shell")).resolves.toBe("")
  })

  test("claudePaneId falls back to the first pane when none is tagged claude", async () => {
    state.router = (cmd) =>
      subcommandOf(cmd) === "list-panes" ? { code: 0, stdout: "%0\t\n%1\ttasks\n" } : { code: 1 }
    await expect(client.claudePaneId("kobe-t1")).resolves.toBe("%0")
  })

  test("claudePaneIdStrict returns '' with no fallback when untagged", async () => {
    state.router = (cmd) =>
      subcommandOf(cmd) === "list-panes" ? { code: 0, stdout: "%0\t\n%1\ttasks\n" } : { code: 1 }
    await expect(client.claudePaneIdStrict("kobe-t1")).resolves.toBe("")
  })

  test("capturePaneById returns '' for an empty pane id without spawning", async () => {
    state.router = () => {
      throw new Error("should not spawn for an empty pane id")
    }
    await expect(client.capturePaneById("")).resolves.toBe("")
  })

  test("capturePaneById returns the raw (unstripped) capture text", async () => {
    state.router = (cmd) =>
      subcommandOf(cmd) === "capture-pane" ? { code: 0, stdout: "line one\nline two\n" } : { code: 1 }
    await expect(client.capturePaneById("%1")).resolves.toBe("line one\nline two\n")
  })
})

describe("newWindow / windowIsSurface", () => {
  test("a surface window is captured by id and tagged @kobe_surface", async () => {
    const calls: string[][] = []
    state.router = (cmd) => {
      calls.push(cmd)
      if (subcommandOf(cmd) === "new-window") return { code: 0, stdout: "@7\n" }
      return { code: 0 }
    }
    await client.newWindow("kobe-t1", { cwd: "/wt", command: "kobe settings", name: "settings", surface: true })
    const setOption = calls.find((c) => subcommandOf(c) === "set-window-option")
    expect(setOption).toEqual(expect.arrayContaining(["-t", "@7", "@kobe_surface", "1"]))
  })

  test("a non-surface window issues a plain new-window with no follow-up tag", async () => {
    const calls: string[][] = []
    state.router = (cmd) => {
      calls.push(cmd)
      return { code: 0 }
    }
    await client.newWindow("kobe-t1", { cwd: "/wt", command: "echo hi" })
    expect(calls.some((c) => subcommandOf(c) === "set-window-option")).toBe(false)
  })

  test("windowIsSurface is true only when the tag reads back '1'", async () => {
    state.router = (cmd) => (subcommandOf(cmd) === "display-message" ? { code: 0, stdout: "1\n" } : { code: 1 })
    await expect(client.windowIsSurface("@7")).resolves.toBe(true)
    state.router = (cmd) => (subcommandOf(cmd) === "display-message" ? { code: 0, stdout: "\n" } : { code: 1 })
    await expect(client.windowIsSurface("@7")).resolves.toBe(false)
  })
})

describe("currentSessionName", () => {
  test("resolves the trimmed session name from display-message", async () => {
    state.router = (cmd) => (subcommandOf(cmd) === "display-message" ? { code: 0, stdout: "kobe-t1\n" } : { code: 1 })
    await expect(client.currentSessionName()).resolves.toBe("kobe-t1")
  })

  test("resolves to null when outside any tmux pane / on failure", async () => {
    state.router = () => ({ code: 1, stdout: "" })
    await expect(client.currentSessionName()).resolves.toBeNull()
  })
})

describe("termAllPaneGroups / killSession", () => {
  let killSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    killSpy = vi.fn(() => true)
    vi.spyOn(process, "kill").mockImplementation(killSpy as unknown as typeof process.kill)
  })

  test("SIGTERMs every listed pane's process group", async () => {
    state.router = (cmd) => (subcommandOf(cmd) === "list-panes" ? { code: 0, stdout: "111\n222\n" } : { code: 0 })
    await client.termAllPaneGroups()
    expect(killSpy).toHaveBeenCalledWith(-111, "SIGTERM")
    expect(killSpy).toHaveBeenCalledWith(-222, "SIGTERM")
  })

  test("skips pids that are non-finite or <= 1 (never signal pid 1 / garbage)", async () => {
    state.router = (cmd) => (subcommandOf(cmd) === "list-panes" ? { code: 0, stdout: "1\nnot-a-pid\n\n" } : { code: 0 })
    await client.termAllPaneGroups()
    expect(killSpy).not.toHaveBeenCalled()
  })

  test("killSession no-ops entirely when neither the session nor its hidden helper exist", async () => {
    const calls: string[][] = []
    state.router = (cmd) => {
      calls.push(cmd)
      return { code: subcommandOf(cmd) === "has-session" ? 1 : 0 }
    }
    await client.killSession("kobe-t1")
    expect(calls.some((c) => subcommandOf(c) === "kill-session")).toBe(false)
  })

  test("killSession kills both the hidden helper (if present) and the session", async () => {
    const calls: string[][] = []
    state.router = (cmd) => {
      calls.push(cmd)
      return { code: 0 } // has-session always "exists"
    }
    await client.killSession("kobe-t1")
    const killed = calls.filter((c) => subcommandOf(c) === "kill-session").map((c) => c[c.indexOf("-t") + 1])
    expect(killed).toContain("=kobe-t1")
    expect(killed.some((t) => t?.includes("kobe-hidden-"))).toBe(true)
  })
})

describe("literal-text vs key-name sends", () => {
  test("sendKeys sends literal text with -l and a -- guard", async () => {
    const calls: string[][] = []
    state.router = (cmd) => {
      calls.push(cmd)
      return { code: 0 }
    }
    await client.sendKeys("%1", "-not-a-flag")
    expect(calls[0]).toEqual(expect.arrayContaining(["send-keys", "-t", "%1", "-l", "--", "-not-a-flag"]))
  })

  test("sendKeyName sends a bare tmux key name, not literal text", async () => {
    const calls: string[][] = []
    state.router = (cmd) => {
      calls.push(cmd)
      return { code: 0 }
    }
    await client.sendKeyName("%1", "Enter")
    expect(calls[0]).toEqual(expect.arrayContaining(["send-keys", "-t", "%1", "Enter"]))
    expect(calls[0]).not.toContain("-l")
  })
})

describe("tagPaneRole / tagClaudePane / setWindowOption", () => {
  test("tagPaneRole sets the per-pane @kobe_role option", async () => {
    const calls: string[][] = []
    state.router = (cmd) => {
      calls.push(cmd)
      return { code: 0 }
    }
    await client.tagPaneRole("%1", "tasks")
    expect(calls[0]).toEqual(expect.arrayContaining(["set-option", "-p", "-t", "%1", "@kobe_role", "tasks"]))
  })

  test("tagClaudePane tags the pane with the claude role value", async () => {
    const calls: string[][] = []
    state.router = (cmd) => {
      calls.push(cmd)
      return { code: 0 }
    }
    await client.tagClaudePane("%1")
    expect(calls[0]).toEqual(expect.arrayContaining(["set-option", "-p", "-t", "%1", "@kobe_role", "claude"]))
  })

  test("setWindowOption targets any pane inside the window", async () => {
    const calls: string[][] = []
    state.router = (cmd) => {
      calls.push(cmd)
      return { code: 0 }
    }
    await client.setWindowOption("%1", "@kobe_session_id", "abc-123")
    expect(calls[0]).toEqual(expect.arrayContaining(["set-window-option", "-t", "%1", "@kobe_session_id", "abc-123"]))
  })
})

describe("ensureFallbackSession / switchClientBeforeKill", () => {
  test("reuses an existing kobe-home session already tagged as the tasks home", async () => {
    const calls: string[][] = []
    state.router = (cmd) => {
      calls.push(cmd)
      if (subcommandOf(cmd) === "has-session") return { code: 0 }
      if (subcommandOf(cmd) === "show-options") return { code: 0, stdout: "tasks\n" }
      return { code: 0 }
    }
    await expect(client.ensureFallbackSession()).resolves.toBe("kobe-home")
    expect(calls.some((c) => subcommandOf(c) === "new-session")).toBe(false)
  })

  test("rebuilds a legacy kobe-home missing the tasks tag", async () => {
    const calls: string[][] = []
    let sessionKilled = false
    state.router = (cmd) => {
      calls.push(cmd)
      const sub = subcommandOf(cmd)
      if (sub === "has-session") return { code: 0 }
      if (sub === "show-options") return { code: 0, stdout: "" }
      if (sub === "kill-session") {
        sessionKilled = true
        return { code: 0 }
      }
      if (sub === "new-session" || sub === "split-window") return { code: 0, stdout: "%1\n" }
      return { code: 0 }
    }
    await expect(client.ensureFallbackSession()).resolves.toBe("kobe-home")
    expect(sessionKilled).toBe(true)
    expect(calls.some((c) => subcommandOf(c) === "new-session")).toBe(true)
  })

  test("switchClientBeforeKill no-ops when the current session isn't the one being killed", async () => {
    state.router = (cmd) =>
      subcommandOf(cmd) === "display-message" ? { code: 0, stdout: "kobe-other\n" } : { code: 0 }
    await client.switchClientBeforeKill("kobe-t1")
    expect(enterWindowMock).not.toHaveBeenCalled()
  })

  test("switchClientBeforeKill switches to the next session when attached to the killed one", async () => {
    state.router = (cmd) => {
      const sub = subcommandOf(cmd)
      if (sub === "display-message") return { code: 0, stdout: "kobe-t1\n" }
      if (sub === "has-session") return { code: 0 }
      return { code: 0 }
    }
    await client.switchClientBeforeKill("kobe-t1", "kobe-t2")
    expect(enterWindowMock).toHaveBeenCalledWith("kobe-t2")
  })
})
