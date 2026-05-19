import { describe, expect, it } from "vitest"
import {
  DEFAULT_KEYBINDINGS,
  buildBindKeyArgs,
  buildRunShellCommand,
} from "../../src/tmux/keybindings.ts"

describe("DEFAULT_KEYBINDINGS", () => {
  it("covers the M-1..9 tab-switch chords", () => {
    for (let n = 1; n <= 9; n++) {
      const def = DEFAULT_KEYBINDINGS.find((b) => b.key === `M-${n}`)
      expect(def, `missing M-${n}`).toBeDefined()
      expect(def?.action).toEqual({ kind: "rpc", verb: "switch-tab", args: [String(n)] })
    }
  })

  it("covers tab + task chords", () => {
    expect(DEFAULT_KEYBINDINGS.find((b) => b.key === "M-t")?.action).toEqual({
      kind: "rpc",
      verb: "new-tab",
      args: [],
    })
    expect(DEFAULT_KEYBINDINGS.find((b) => b.key === "M-w")?.action).toEqual({
      kind: "rpc",
      verb: "close-tab",
      args: [],
    })
    expect(DEFAULT_KEYBINDINGS.find((b) => b.key === "M-n")?.action).toEqual({
      kind: "rpc",
      verb: "next-task",
      args: [],
    })
    expect(DEFAULT_KEYBINDINGS.find((b) => b.key === "M-p")?.action).toEqual({
      kind: "rpc",
      verb: "prev-task",
      args: [],
    })
  })

  it("covers M-h/j/k/l pane-navigation as in-tmux select-pane calls", () => {
    expect(DEFAULT_KEYBINDINGS.find((b) => b.key === "M-h")?.action).toEqual({
      kind: "select-pane",
      direction: "L",
    })
    expect(DEFAULT_KEYBINDINGS.find((b) => b.key === "M-j")?.action).toEqual({
      kind: "select-pane",
      direction: "D",
    })
    expect(DEFAULT_KEYBINDINGS.find((b) => b.key === "M-k")?.action).toEqual({
      kind: "select-pane",
      direction: "U",
    })
    expect(DEFAULT_KEYBINDINGS.find((b) => b.key === "M-l")?.action).toEqual({
      kind: "select-pane",
      direction: "R",
    })
  })

  it("has exactly the documented binding count (9 tabs + 4 pane nav + 4 task/tab actions)", () => {
    expect(DEFAULT_KEYBINDINGS.length).toBe(9 + 4 + 4)
  })
})

describe("buildRunShellCommand", () => {
  it("composes <bin> rpc <verb> [args] --no-wait", () => {
    expect(buildRunShellCommand("kobe", "new-tab", [])).toBe("kobe rpc new-tab --no-wait")
    expect(buildRunShellCommand("kobe", "switch-tab", ["3"])).toBe("kobe rpc switch-tab 3 --no-wait")
    expect(buildRunShellCommand("/opt/kobe", "switch-task", ["task-42"])).toBe(
      "/opt/kobe rpc switch-task task-42 --no-wait",
    )
  })
})

describe("buildBindKeyArgs", () => {
  it("emits one argv per binding, all on root table, all unbound from the prefix", () => {
    const argvs = buildBindKeyArgs()
    expect(argvs.length).toBe(DEFAULT_KEYBINDINGS.length)
    for (const argv of argvs) {
      expect(argv[0]).toBe("bind-key")
      expect(argv[1]).toBe("-n")
      expect(argv[2]).toBe("-T")
      expect(argv[3]).toBe("root")
      expect(typeof argv[4]).toBe("string")
    }
  })

  it("default kobeBin is 'kobe'", () => {
    const argvs = buildBindKeyArgs()
    const newTab = argvs.find((a) => a[4] === "M-t")
    expect(newTab).toBeDefined()
    expect(newTab?.[5]).toBe("run-shell")
    expect(newTab?.[6]).toBe("kobe rpc new-tab --no-wait")
  })

  it("respects a kobeBin override (e.g. dev runs via bun)", () => {
    const argvs = buildBindKeyArgs({ kobeBin: "bun /abs/src/cli/index.ts" })
    const switchTab3 = argvs.find((a) => a[4] === "M-3")
    expect(switchTab3?.[6]).toBe("bun /abs/src/cli/index.ts rpc switch-tab 3 --no-wait")
  })

  it("uses run-shell for rpc bindings and select-pane directly for pane nav", () => {
    const argvs = buildBindKeyArgs()
    const newTab = argvs.find((a) => a[4] === "M-t")
    expect(newTab?.[5]).toBe("run-shell")

    const paneLeft = argvs.find((a) => a[4] === "M-h")
    expect(paneLeft?.[5]).toBe("select-pane")
    expect(paneLeft?.[6]).toBe("-L")
    expect(paneLeft?.length).toBe(7)
  })

  it("produces stable argv shape across calls (snapshot)", () => {
    expect(buildBindKeyArgs({ kobeBin: "kobe" })).toMatchInlineSnapshot(`
      [
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-1",
          "run-shell",
          "kobe rpc switch-tab 1 --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-2",
          "run-shell",
          "kobe rpc switch-tab 2 --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-3",
          "run-shell",
          "kobe rpc switch-tab 3 --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-4",
          "run-shell",
          "kobe rpc switch-tab 4 --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-5",
          "run-shell",
          "kobe rpc switch-tab 5 --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-6",
          "run-shell",
          "kobe rpc switch-tab 6 --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-7",
          "run-shell",
          "kobe rpc switch-tab 7 --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-8",
          "run-shell",
          "kobe rpc switch-tab 8 --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-9",
          "run-shell",
          "kobe rpc switch-tab 9 --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-t",
          "run-shell",
          "kobe rpc new-tab --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-w",
          "run-shell",
          "kobe rpc close-tab --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-n",
          "run-shell",
          "kobe rpc next-task --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-p",
          "run-shell",
          "kobe rpc prev-task --no-wait",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-h",
          "select-pane",
          "-L",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-j",
          "select-pane",
          "-D",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-k",
          "select-pane",
          "-U",
        ],
        [
          "bind-key",
          "-n",
          "-T",
          "root",
          "M-l",
          "select-pane",
          "-R",
        ],
      ]
    `)
  })
})
