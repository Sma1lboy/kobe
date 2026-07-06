import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  existingSessions: new Set<string>(),
  observeStdout: "",
  healStdout: "",
  newSessionPaneId: "%0",
  calls: [] as string[][],
  sequences: [] as string[][][],
  sessionOptions: [] as string[][],
  sequenceExitCode: 0,
}))

vi.mock("../../src/cli/invocation", () => ({ kobeCliInvocation: () => ["kobe"] }))
vi.mock("../../src/exec/resolve", () => ({
  localSpawnCwd: (p: string) => p,
  remoteKeyForRepo: (repo: string | undefined) => (repo?.startsWith("ssh://") ? repo : undefined),
}))
vi.mock("../../src/tmux/clipboard", () => ({
  clipboardBinaryOnPath: () => false,
  resolveClipboardCopyCommand: () => null,
  clipboardTmuxConfig: () => [["set-option", "-g", "set-clipboard", "on"]],
}))
vi.mock("../../src/tmux/prompt-delivery", () => ({
  deliverFirstEngineMessage: vi.fn(async () => {}),
}))
vi.mock("../../src/tui/lib/tmux-border-theme", () => ({ applyTmuxChromeTheme: vi.fn(async () => {}) }))
vi.mock("../../src/state/keybindings-file", () => ({
  readKeybindingsFile: () => ({ path: "/nope/keybindings.yaml", exists: false, doc: null, warnings: [] }),
  resetKeybindingsFileCache: () => {},
}))
vi.mock("../../src/state/archived-history", () => ({ archivedHistoryPreviewEnabled: () => false }))
vi.mock("../../src/tui/panes/terminal/chattab", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/panes/terminal/chattab")>()
  return { ...actual, buildPanesAround: vi.fn(async () => {}) }
})

vi.mock("../../src/tmux/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client")>()
  return {
    ...actual,
    sessionExists: async (name: string) => state.existingSessions.has(name),
    killSession: async (name: string) => {
      state.calls.push(["killSession", name])
      state.existingSessions.delete(name)
    },
    setSessionOption: async (_s: string, option: string, value: string) => {
      state.sessionOptions.push([option, value])
    },
    setWindowOption: async (target: string, option: string, value: string) => {
      state.calls.push(["set-window-option", target, option, value])
    },
    runTmux: async (args: string[]) => {
      state.calls.push(args)
      return 0
    },
    runTmuxSequence: async (commands: readonly (readonly string[])[]) => {
      state.sequences.push(commands.map((c) => [...c]))
      for (const c of commands) state.calls.push([...c])
      return state.sequenceExitCode
    },
    runTmuxCapturing: async (args: string[]) => {
      state.calls.push(args)
      if (args[0] === "new-session") return { code: 0, stdout: `${state.newSessionPaneId}\n` }
      const fIdx = args.indexOf("-F")
      const format = fIdx >= 0 ? (args[fIdx + 1] ?? "") : ""
      if (args[0] === "list-panes" && format.includes("window_active")) {
        return { code: 0, stdout: state.observeStdout }
      }
      if (args[0] === "list-panes" && format.includes("@kobe_pane_version")) {
        return { code: 0, stdout: state.healStdout }
      }
      return { code: 0, stdout: "" }
    },
    runTmuxSequenceCapturing: async () => ({ code: 0, stdout: "" }),
  }
})

const tmux = await import("../../src/tui/panes/terminal/tmux")
const promptDelivery = await import("../../src/tmux/prompt-delivery")
const chattab = await import("../../src/tui/panes/terminal/chattab")

let home: string
let prevHome: string | undefined
let prevTmuxVar: string | undefined

function flatCalls(): string[] {
  return state.calls.map((c) => c.join(" "))
}

beforeEach(() => {
  state.existingSessions = new Set()
  state.observeStdout = ""
  state.healStdout = ""
  state.newSessionPaneId = "%0"
  state.calls = []
  state.sequences = []
  state.sessionOptions = []
  state.sequenceExitCode = 0
  vi.clearAllMocks()
  prevHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-ensure-"))
  process.env.KOBE_HOME_DIR = home
  prevTmuxVar = process.env.TMUX
  Reflect.deleteProperty(process.env, "TMUX")
})

afterEach(() => {
  vi.clearAllMocks()
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  if (prevTmuxVar === undefined) Reflect.deleteProperty(process.env, "TMUX")
  else process.env.TMUX = prevTmuxVar
  rmSync(home, { recursive: true, force: true })
})

describe("ensureSession — fresh create", () => {
  test("builds the session: engine pane, tags, panes, bindings, claude focus", async () => {
    const ok = await tmux.ensureSession({
      name: "kobe-t1",
      cwd: "/wt",
      command: ["claude"],
      taskId: "t1",
      vendor: "claude",
      repo: "/repo",
    })
    expect(ok).toBe(true)
    const newSession = state.calls.find((c) => c[0] === "new-session")
    expect(newSession).toEqual(expect.arrayContaining(["-d", "-s", "kobe-t1", "-c", "/wt"]))
    expect(newSession?.[newSession.length - 1]).toContain("claude")
    expect(newSession?.[newSession.length - 1]).toContain("--session-id")
    expect(state.calls.some((c) => c[0] === "set-window-option" && c[2] === "@kobe_session_id")).toBe(true)
    expect(state.calls).toEqual(
      expect.arrayContaining([
        ["set-option", "-t", "kobe-t1", "@kobe_task", "t1"],
        ["set-option", "-t", "kobe-t1", "@kobe_worktree", "/wt"],
        ["set-option", "-t", "kobe-t1", "@kobe_vendor", "claude"],
      ]),
    )
    expect(chattab.buildPanesAround).toHaveBeenCalledWith("%0", expect.objectContaining({ cwd: "/wt", taskId: "t1" }))
    const flat = flatCalls()
    expect(flat).toContain("set-option -g status on")
    expect(flat.some((c) => c.startsWith("set-hook -g window-resized"))).toBe(true)
    expect(flat.some((c) => c.startsWith("set-hook -g client-resized"))).toBe(true)
    expect(flat.some((c) => c.startsWith("set-hook -g pane-exited"))).toBe(true)
    expect(flat.some((c) => c.startsWith("bind-key -n C-t run-shell"))).toBe(true)
    expect(state.calls[state.calls.length - 1]).toEqual(["select-pane", "-t", "%0"])
  })

  test("no remote tag for a local repo; ssh:// repos get REMOTE_KEY_OPTION", async () => {
    await tmux.ensureSession({ name: "kobe-t1", cwd: "/wt", command: ["claude"], repo: "/repo" })
    expect(state.calls.some((c) => c[3] === "@kobe_remote")).toBe(false)
  })

  test("fails soft when new-session yields no pane id", async () => {
    state.newSessionPaneId = ""
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const ok = await tmux.ensureSession({ name: "kobe-t1", cwd: "/wt", command: ["claude"] })
    expect(ok).toBe(false)
    expect(chattab.buildPanesAround).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  test("delivers the repo's first message fire-and-forget on the create path only", async () => {
    await tmux.ensureSession({
      name: "kobe-t1",
      cwd: "/wt",
      command: ["claude"],
      vendor: "claude",
      launchInit: { firstMessage: { text: "do the thing", source: "repo-init" } },
    })
    expect(promptDelivery.deliverFirstEngineMessage).toHaveBeenCalledWith("kobe-t1", {
      text: "do the thing",
      source: "repo-init",
    })
  })

  test("no first message → no delivery attempt", async () => {
    await tmux.ensureSession({ name: "kobe-t1", cwd: "/wt", command: ["claude"], vendor: "claude" })
    expect(promptDelivery.deliverFirstEngineMessage).not.toHaveBeenCalled()
  })

  test("concurrent ensureSession calls for the same name share one build", async () => {
    const [a, b] = await Promise.all([
      tmux.ensureSession({ name: "kobe-t1", cwd: "/wt", command: ["claude"] }),
      tmux.ensureSession({ name: "kobe-t1", cwd: "/wt", command: ["claude"] }),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(state.calls.filter((c) => c[0] === "new-session")).toHaveLength(1)
  })
})

describe("ensureSession — rebuild and vendor switch", () => {
  test("a stale session (worktree mismatch) is killed and rebuilt", async () => {
    state.existingSessions = new Set(["kobe-t1"])
    state.observeStdout = "@1\t1\tclaude\t/OLD-wt\tclaude"
    const ok = await tmux.ensureSession({ name: "kobe-t1", cwd: "/wt", command: ["claude"], vendor: "claude" })
    expect(ok).toBe(true)
    expect(state.calls).toEqual(expect.arrayContaining([["killSession", "kobe-t1"]]))
    expect(state.calls.some((c) => c[0] === "new-session")).toBe(true)
  })

  test("vendor switch respawns the engine pane in place and advances @kobe_vendor", async () => {
    state.existingSessions = new Set(["kobe-t1"])
    state.observeStdout = "@1\t1\tclaude\t/wt\tclaude"
    state.healStdout = "@1\t%0\tclaude\t0.0.1\t120"
    const ok = await tmux.ensureSession({ name: "kobe-t1", cwd: "/wt", command: ["codex"], vendor: "codex" })
    expect(ok).toBe(true)
    expect(state.calls.some((c) => c[0] === "killSession")).toBe(false)
    expect(state.calls.some((c) => c[0] === "respawn-pane" && c.includes("%0"))).toBe(true)
    expect(state.sessionOptions).toEqual(expect.arrayContaining([["@kobe_vendor", "codex"]]))
  })

  test("a failed respawn keeps the OLD vendor tag so the next enter retries", async () => {
    state.existingSessions = new Set(["kobe-t1"])
    state.observeStdout = "@1\t1\tclaude\t/wt\tclaude"
    state.healStdout = "@1\t%0\tclaude\t0.0.1\t120"
    state.sequenceExitCode = 1
    const ok = await tmux.ensureSession({ name: "kobe-t1", cwd: "/wt", command: ["codex"], vendor: "codex" })
    expect(ok).toBe(true)
    expect(state.sessionOptions.some(([opt, val]) => opt === "@kobe_vendor" && val === "codex")).toBe(false)
    expect(state.calls.some((c) => c[0] === "killSession")).toBe(false)
  })

  test("a vendor switch with NO engine pane falls through to a full rebuild", async () => {
    state.existingSessions = new Set(["kobe-t1"])
    state.observeStdout = "@1\t1\t\t/wt\tclaude"
    state.healStdout = ""
    const ok = await tmux.ensureSession({ name: "kobe-t1", cwd: "/wt", command: ["codex"], vendor: "codex" })
    expect(ok).toBe(true)
    expect(state.calls).toEqual(expect.arrayContaining([["killSession", "kobe-t1"]]))
    expect(state.calls.some((c) => c[0] === "new-session")).toBe(true)
  })
})

describe("ensureSession — archived history preview + in-tmux window fit", () => {
  test("archived + beta gate launches `kobe history` instead of the engine (no session id pin)", async () => {
    const archived = await import("../../src/state/archived-history")
    vi.spyOn(archived, "archivedHistoryPreviewEnabled").mockReturnValue(true)
    await tmux.ensureSession({
      name: "kobe-t1",
      cwd: "/spawn-dir",
      command: ["claude"],
      taskId: "t1",
      vendor: "claude",
      archived: true,
      archivedWorktree: "/recorded-wt",
      title: "My Task",
    })
    const newSession = state.calls.find((c) => c[0] === "new-session")
    const paneCmd = newSession?.[newSession.length - 1] ?? ""
    expect(paneCmd).toContain("history")
    expect(paneCmd).toContain("/recorded-wt")
    expect(paneCmd).toContain("My Task")
    expect(paneCmd).not.toContain("--session-id")
    expect(state.calls.some((c) => c[0] === "set-window-option" && c[2] === "@kobe_session_id")).toBe(false)
  })

  test("live preview mode tails the transcript with --live", async () => {
    const archived = await import("../../src/state/archived-history")
    vi.spyOn(archived, "archivedHistoryPreviewEnabled").mockReturnValue(true)
    await tmux.ensureSession({
      name: "kobe-t1",
      cwd: "/wt",
      command: ["claude"],
      vendor: "claude",
      preview: true,
      archivedWorktree: "/wt",
    })
    const newSession = state.calls.find((c) => c[0] === "new-session")
    expect(newSession?.[newSession.length - 1]).toContain("--live")
  })

  test("inside tmux, the fresh window is fit to the attached client BEFORE panes split", async () => {
    process.env.TMUX = "/tmp/tmux-sock,1,0"
    const client = await import("../../src/tmux/client")
    vi.spyOn(client, "runTmuxCapturing").mockImplementation(async (args: string[]) => {
      state.calls.push(args)
      if (args[0] === "new-session") return { code: 0, stdout: "%0\n" }
      if (args[0] === "display-message") return { code: 0, stdout: "cli\t180\t45\ton" }
      if (args[0] === "list-panes") return { code: 0, stdout: "" }
      return { code: 0, stdout: "" }
    })
    await tmux.ensureSession({ name: "kobe-t1", cwd: "/wt", command: ["claude"], vendor: "claude" })
    const resize = state.calls.find((c) => c[0] === "resize-window")
    expect(resize).toEqual(["resize-window", "-t", "=kobe-t1", "-x", "180", "-y", "44"])
  })
})
