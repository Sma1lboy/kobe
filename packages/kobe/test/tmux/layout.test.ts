import { describe, expect, it } from "vitest"
import {
  DEFAULT_PLACEHOLDERS,
  buildLayoutSteps,
  panePaneCommand,
  placeholderShellCommand,
  shellPaneCommand,
} from "../../src/tmux/layout.ts"

describe("placeholderShellCommand", () => {
  it("prints the label once then blocks via tail -f", () => {
    expect(placeholderShellCommand("hello")).toBe(`printf '%s\\n' 'hello'; exec tail -f /dev/null`)
  })

  it("escapes single quotes in the label", () => {
    expect(placeholderShellCommand("it's me")).toContain(`'it'\\''s me'`)
  })
})

describe("panePaneCommand", () => {
  it("builds `exec <bin> pane <name>`", () => {
    expect(panePaneCommand("sidebar", "kobe")).toBe("exec kobe pane sidebar")
    expect(panePaneCommand("tab-strip", "/usr/local/bin/kobe")).toBe("exec /usr/local/bin/kobe pane tab-strip")
  })
})

describe("shellPaneCommand", () => {
  it("defaults to bash when $SHELL is unset", () => {
    expect(shellPaneCommand()).toBe("exec bash")
  })
  it("respects an explicit shell path", () => {
    expect(shellPaneCommand("/bin/zsh")).toBe("exec /bin/zsh")
  })
})

describe("buildLayoutSteps", () => {
  it("falls back to placeholders when paneCommands is omitted", () => {
    const steps = buildLayoutSteps({ sessionName: "kobe-test", placeholders: DEFAULT_PLACEHOLDERS })
    const sidebar = steps.find((s) => s.kind === "new-session")
    expect(sidebar?.command).toBe(placeholderShellCommand(DEFAULT_PLACEHOLDERS.sidebar))
    const chat = steps.find((s) => s.kind === "split" && s.name === "chat")
    expect(chat && chat.kind === "split" && chat.command).toBe(placeholderShellCommand(DEFAULT_PLACEHOLDERS.chat))
  })

  it("uses paneCommands overrides per pane when supplied", () => {
    const steps = buildLayoutSteps({
      sessionName: "kobe-test",
      placeholders: DEFAULT_PLACEHOLDERS,
      paneCommands: {
        sidebar: panePaneCommand("sidebar", "kobe"),
        tabStrip: panePaneCommand("tab-strip", "kobe"),
        files: panePaneCommand("files", "kobe"),
        shell: shellPaneCommand("/bin/zsh"),
      },
    })
    const session = steps.find((s) => s.kind === "new-session")
    expect(session?.command).toBe("exec kobe pane sidebar")

    const tabStrip = steps.find((s) => s.kind === "split" && s.name === "tab-strip")
    expect(tabStrip && tabStrip.kind === "split" && tabStrip.command).toBe("exec kobe pane tab-strip")

    const files = steps.find((s) => s.kind === "split" && s.name === "files")
    expect(files && files.kind === "split" && files.command).toBe("exec kobe pane files")

    const shell = steps.find((s) => s.kind === "split" && s.name === "shell")
    expect(shell && shell.kind === "split" && shell.command).toBe("exec /bin/zsh")

    // Chat stayed on the placeholder — sprint-5 wires the engine in.
    const chat = steps.find((s) => s.kind === "split" && s.name === "chat")
    expect(chat && chat.kind === "split" && chat.command).toBe(placeholderShellCommand(DEFAULT_PLACEHOLDERS.chat))
  })

  it("emits the canonical 7-step skeleton", () => {
    const steps = buildLayoutSteps({ sessionName: "kobe-test", placeholders: DEFAULT_PLACEHOLDERS })
    expect(steps.map((s) => ({ kind: s.kind, name: "name" in s ? s.name : undefined })))
      .toEqual([
        { kind: "new-session", name: "sidebar" },
        { kind: "split", name: "tab-strip" },
        { kind: "split", name: "files" },
        { kind: "split", name: "chat" },
        { kind: "resize", name: undefined },
        { kind: "split", name: "shell" },
        { kind: "select", name: undefined },
      ])
  })

  it("focuses chat by default", () => {
    const steps = buildLayoutSteps({ sessionName: "kobe-test", placeholders: DEFAULT_PLACEHOLDERS })
    const last = steps[steps.length - 1]
    expect(last?.kind).toBe("select")
    expect(last && last.kind === "select" && last.targetLabel).toBe("chat")
  })
})
