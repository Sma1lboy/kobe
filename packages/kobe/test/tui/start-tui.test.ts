import { beforeEach, describe, expect, it, vi } from "vitest"

const spies = vi.hoisted(() => ({
  enforceResetGate: vi.fn(),
  hintSkillInstall: vi.fn(),
  installHooks: vi.fn(async () => {}),
  publishTitle: vi.fn(),
  startWorkspaceHost: vi.fn(async () => {}),
}))

vi.mock("../../src/cli/hook-cmd.ts", () => ({ ensureGlobalKobeHooks: spies.installHooks }))
vi.mock("../../src/cli/reset-gate.ts", () => ({ enforceResetGate: spies.enforceResetGate }))
vi.mock("../../src/lib/skill-install.ts", () => ({ maybeHintSkillInstall: spies.hintSkillInstall }))
vi.mock("../../src/tui/lib/outer-terminal-title.ts", () => ({ publishKobeTerminalTitle: spies.publishTitle }))
vi.mock("../../src/tui-react/workspace/host", () => ({ startWorkspaceHost: spies.startWorkspaceHost }))

import { startTui } from "../../src/tui/index"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("startTui", () => {
  it("starts the sole Workspace Host", async () => {
    await startTui()

    expect(spies.startWorkspaceHost).toHaveBeenCalledOnce()
  })

  it("installs engine hooks before starting the Workspace Host", async () => {
    const order: string[] = []
    spies.installHooks.mockImplementationOnce(async () => {
      order.push("hooks")
    })
    spies.startWorkspaceHost.mockImplementationOnce(async () => {
      order.push("host")
    })

    await startTui()

    expect(spies.installHooks).toHaveBeenCalledOnce()
    expect(order).toEqual(["hooks", "host"])
  })
})
