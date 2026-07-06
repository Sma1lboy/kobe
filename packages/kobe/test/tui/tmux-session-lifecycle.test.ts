import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  existingSessions: new Set<string>(["kobe-t1"]),
  calls: [] as string[][],
  capturingCalls: [] as string[][],
  clientListStdout: "",
  displayMessageStdout: "",
  sessionOptions: {} as Record<string, string>,
  paneRows: [] as Array<{ windowId: string; paneId: string; role: string; version: string; paneWidth?: number }>,
  observeStdout: "",
}))

vi.mock("../../src/cli/invocation", () => ({ kobeCliInvocation: () => ["kobe"] }))
vi.mock("../../src/exec/resolve", () => ({
  localSpawnCwd: (p: string) => p,
  remoteKeyForRepo: () => undefined,
}))
vi.mock("../../src/tui/lib/tmux-border-theme", () => ({ applyTmuxChromeTheme: vi.fn(async () => {}) }))

vi.mock("../../src/tmux/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client")>()
  return {
    ...actual,
    sessionExists: async (name: string) => state.existingSessions.has(name),
    getSessionOptions: async (_session: string, options: readonly string[]) =>
      Object.fromEntries(options.map((o) => [o, state.sessionOptions[o]])),
    runTmux: async (args: string[]) => {
      state.calls.push(args)
      return 0
    },
    runTmuxSequence: async (commands: readonly (readonly string[])[]) => {
      for (const c of commands) state.calls.push([...c])
      return 0
    },
    runTmuxCapturing: async (args: string[]) => {
      state.capturingCalls.push(args)
      if (args[0] === "list-clients") return { code: 0, stdout: state.clientListStdout }
      if (args[0] === "display-message") return { code: 0, stdout: state.displayMessageStdout }
      if (args[0] === "list-panes") {
        const fIdx = args.indexOf("-F")
        const format = fIdx >= 0 ? args[fIdx + 1] : ""
        if (format?.includes("window_active")) return { code: 0, stdout: state.observeStdout }
        return {
          code: 0,
          stdout: state.paneRows
            .map((r) => `${r.windowId}\t${r.paneId}\t${r.role}\t${r.version}\t${r.paneWidth ?? ""}`)
            .join("\n"),
        }
      }
      return { code: 0, stdout: "" }
    },
  }
})

const tmux = await import("../../src/tui/panes/terminal/tmux")

let home: string
let prevHome: string | undefined
let prevTmuxVar: string | undefined

function resetState(): void {
  state.existingSessions = new Set(["kobe-t1"])
  state.calls = []
  state.capturingCalls = []
  state.clientListStdout = ""
  state.displayMessageStdout = ""
  state.sessionOptions = {}
  state.paneRows = []
  state.observeStdout = ""
}

function callsWith(cmd: string): string[][] {
  return state.calls.filter((c) => c[0] === cmd)
}

beforeEach(() => {
  resetState()
  vi.clearAllMocks()
  prevHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-tmux-lifecycle-"))
  process.env.KOBE_HOME_DIR = home
  prevTmuxVar = process.env.TMUX
  Reflect.deleteProperty(process.env, "TMUX")
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  if (prevTmuxVar === undefined) Reflect.deleteProperty(process.env, "TMUX")
  else process.env.TMUX = prevTmuxVar
  rmSync(home, { recursive: true, force: true })
})

describe("prepareWindowForAttach", () => {
  let prevColumns: number | undefined
  let prevRows: number | undefined

  beforeEach(() => {
    prevColumns = process.stdout.columns
    prevRows = process.stdout.rows
  })

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: prevColumns, configurable: true })
    Object.defineProperty(process.stdout, "rows", { value: prevRows, configurable: true })
  })

  test("resizes the window to process.stdout's size and heals the layout", async () => {
    Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true })
    Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true })
    await tmux.prepareWindowForAttach("kobe-t1")
    const resize = callsWith("resize-window")
    expect(resize).toEqual([["resize-window", "-t", "=kobe-t1", "-x", "200", "-y", "50"]])
  })

  test("skips the resize entirely when the terminal size is unknown", async () => {
    Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true })
    Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true })
    Reflect.deleteProperty(process.env, "COLUMNS")
    Reflect.deleteProperty(process.env, "LINES")
    await tmux.prepareWindowForAttach("kobe-t1")
    expect(callsWith("resize-window")).toEqual([])
  })

  test("marks other attached clients at a conflicting size as ignore-size", async () => {
    Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true })
    Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true })
    state.clientListStdout = "otherclient\tkobe-t1\t100\t30\t\nmatching\tkobe-t1\t200\t50\t"
    await tmux.prepareWindowForAttach("kobe-t1")
    expect(callsWith("refresh-client")).toEqual([["refresh-client", "-f", "ignore-size", "-t", "otherclient"]])
  })
})

describe("prepareWindowForSwitch / enterWindow", () => {
  test("fits the window to the currently-attached client before switching", async () => {
    state.displayMessageStdout = "myclient\t180\t45\ton"
    await tmux.enterWindow("kobe-t1")
    expect(callsWith("resize-window")).toEqual([["resize-window", "-t", "=kobe-t1", "-x", "180", "-y", "44"]])
    expect(callsWith("switch-client")).toEqual([["switch-client", "-t", "=kobe-t1"]])
  })

  test("skips the resize when the attached client's size can't be read", async () => {
    state.displayMessageStdout = ""
    await tmux.enterWindow("kobe-t1")
    expect(callsWith("resize-window")).toEqual([])
    expect(callsWith("switch-client")).toEqual([["switch-client", "-t", "=kobe-t1"]])
  })
})

describe("resyncWindowToClient", () => {
  test("no-ops when the reported size is null", async () => {
    await tmux.resyncWindowToClient("kobe-t1", { size: null, status: "on" })
    expect(state.calls).toEqual([])
  })

  test("batches the window resize with the layout re-pin in one sequence", async () => {
    state.paneRows = [{ windowId: "@1", paneId: "%1", role: "tasks", version: "0.8.0", paneWidth: 10 }]
    await tmux.resyncWindowToClient("kobe-t1", { size: { columns: 200, rows: 50 }, status: "on" })
    expect(callsWith("resize-window")).toEqual([["resize-window", "-t", "=kobe-t1", "-x", "200", "-y", "49"]])
    expect(callsWith("resize-pane")).toEqual([["resize-pane", "-t", "%1", "-x", expect.any(String)]])
  })
})

describe("observeSessionVendor", () => {
  test("returns null when the session doesn't exist", async () => {
    state.existingSessions = new Set()
    await expect(tmux.observeSessionVendor("kobe-ghost")).resolves.toBeNull()
  })

  test("returns the session's tagged vendor when present", async () => {
    state.observeStdout = "@1\t1\tclaude\t/wt\tcodex"
    await expect(tmux.observeSessionVendor("kobe-t1")).resolves.toBe("codex")
  })

  test("returns null when the session exists but carries no vendor tag", async () => {
    state.observeStdout = "@1\t1\tclaude\t/wt\t"
    await expect(tmux.observeSessionVendor("kobe-t1")).resolves.toBeNull()
  })
})

describe("selectTasksPane", () => {
  test("returns '' for a session that doesn't exist", async () => {
    state.existingSessions = new Set()
    await expect(tmux.selectTasksPane("kobe-ghost")).resolves.toBe("")
  })

  test("selects the window's Tasks pane directly when visible", async () => {
    const client = await import("../../src/tmux/client")
    vi.spyOn(client, "runTmuxCapturing").mockImplementation(async (args: string[]) => {
      if (args[0] === "list-panes") return { code: 0, stdout: "%1\tclaude\n%2\ttasks" }
      return { code: 0, stdout: "" }
    })
    await expect(tmux.selectTasksPane("kobe-t1", { windowId: "@1" })).resolves.toBe("%2")
    expect(callsWith("select-pane")).toEqual([["select-pane", "-t", "%2"]])
  })

  test("restores a hidden rail via tasks-restore, then selects the restored pane", async () => {
    const client = await import("../../src/tmux/client")
    let listed = 0
    vi.spyOn(client, "runTmuxCapturing").mockImplementation(async (args: string[]) => {
      state.capturingCalls.push(args)
      if (args[0] === "list-panes") {
        const fIdx = args.indexOf("-F")
        const format = fIdx >= 0 ? (args[fIdx + 1] ?? "") : ""
        if (format.includes("@kobe_role") && !format.includes("pane_active") && !format.includes("pane_width")) {
          listed++
          return { code: 0, stdout: listed === 1 ? "%1\tclaude" : "%1\tclaude\n%7\ttasks" }
        }
        return { code: 0, stdout: "%1\tclaude\t1\t80\t20\t160\t40" }
      }
      if (args[0] === "list-windows") return { code: 0, stdout: "1\t@1" }
      if (args[0] === "show-options") return { code: 0, stdout: "" }
      if (args[0] === "split-window") return { code: 0, stdout: "%7" }
      return { code: 0, stdout: "" }
    })
    await expect(tmux.selectTasksPane("kobe-t1")).resolves.toBe("%7")
    expect(callsWith("select-pane").pop()).toEqual(["select-pane", "-t", "%7"])
  })

  test("no-ops in a full-window tab (no tasks pane, no engine pane) — never grafts a rail", async () => {
    const client = await import("../../src/tmux/client")
    const seen: string[][] = []
    vi.spyOn(client, "runTmuxCapturing").mockImplementation(async (args: string[]) => {
      seen.push(args)
      if (args[0] === "list-panes") return { code: 0, stdout: "%9\t" }
      return { code: 0, stdout: "" }
    })
    await expect(tmux.selectTasksPane("kobe-t1", { windowId: "@5" })).resolves.toBe("")
    expect(seen.filter((c) => c[0] !== "list-panes")).toEqual([])
    expect(callsWith("select-pane")).toEqual([])
    expect(callsWith("split-window")).toEqual([])
  })

  test("returns '' when the rail cannot be restored at all", async () => {
    const client = await import("../../src/tmux/client")
    vi.spyOn(client, "runTmuxCapturing").mockImplementation(async (args: string[]) => {
      if (args[0] === "list-panes") return { code: 0, stdout: "" }
      if (args[0] === "list-windows") return { code: 0, stdout: "1\t@1" }
      return { code: 0, stdout: "" }
    })
    await expect(tmux.selectTasksPane("kobe-t1")).resolves.toBe("")
  })
})
