import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const spies = vi.hoisted(() => ({
  hintSkillInstall: vi.fn(),
  publishTitle: vi.fn(),
  startWorkspaceHost: vi.fn(async () => {}),
  startDirectTmux: vi.fn(async () => {}),
}))

vi.mock("../../src/lib/skill-install.ts", () => ({ maybeHintSkillInstall: spies.hintSkillInstall }))
vi.mock("../../src/tui/lib/outer-terminal-title.ts", () => ({ publishKobeTerminalTitle: spies.publishTitle }))
vi.mock("../../src/tui-react/workspace/host", () => ({ startWorkspaceHost: spies.startWorkspaceHost }))
vi.mock("../../src/tui/direct", () => ({ startDirectTmux: spies.startDirectTmux }))

import { startTui } from "../../src/tui/index"

let originalKobeTui: string | undefined

beforeEach(() => {
  originalKobeTui = process.env.KOBE_TUI
  vi.clearAllMocks()
})

afterEach(() => {
  if (originalKobeTui === undefined) Reflect.deleteProperty(process.env, "KOBE_TUI")
  else process.env.KOBE_TUI = originalKobeTui
})

describe("startTui", () => {
  it("starts the Workspace Host for puretui without an environment switch", async () => {
    Reflect.deleteProperty(process.env, "KOBE_TUI")

    await startTui("puretui")

    expect(spies.startWorkspaceHost).toHaveBeenCalledOnce()
    expect(spies.startDirectTmux).not.toHaveBeenCalled()
  })

  it("starts tmux Handover for tmux even when the retired environment switch is set", async () => {
    process.env.KOBE_TUI = "1"

    await startTui("tmux")

    expect(spies.startDirectTmux).toHaveBeenCalledOnce()
    expect(spies.startWorkspaceHost).not.toHaveBeenCalled()
  })
})
