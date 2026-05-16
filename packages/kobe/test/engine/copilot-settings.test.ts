import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { COPILOT_FALLBACK_DEFAULT_MODEL_ID } from "@/engine/copilot-local/models"
import { afterEach, describe, expect, it, vi } from "vitest"

const originalHome = process.env.HOME

describe("copilot settings", () => {
  afterEach(() => {
    process.env.HOME = originalHome
    vi.resetModules()
  })

  it("trims configured default models", async () => {
    const root = await makeHomeWithSettings({ model: "  gpt-5  " })
    process.env.HOME = root
    vi.resetModules()

    const { resolveCopilotDefaultModelId } = await import("@/engine/copilot-local/settings")

    expect(resolveCopilotDefaultModelId()).toBe("gpt-5")
  })

  it("ignores whitespace-only configured default models", async () => {
    const root = await makeHomeWithSettings({ model: "   " })
    process.env.HOME = root
    vi.resetModules()

    const { resolveCopilotDefaultModelId } = await import("@/engine/copilot-local/settings")

    expect(resolveCopilotDefaultModelId()).toBe(COPILOT_FALLBACK_DEFAULT_MODEL_ID)
  })
})

async function makeHomeWithSettings(settings: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kobe-copilot-settings-"))
  await mkdir(path.join(root, ".copilot"), { recursive: true })
  await writeFile(path.join(root, ".copilot", "settings.json"), JSON.stringify(settings))
  return root
}
