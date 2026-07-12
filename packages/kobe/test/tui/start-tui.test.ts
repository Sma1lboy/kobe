import { beforeEach, describe, expect, it, vi } from "vitest"

const spies = vi.hoisted(() => ({
  hintSkillInstall: vi.fn(),
  publishTitle: vi.fn(),
  startWorkspaceHost: vi.fn(async () => {}),
}))

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
})
