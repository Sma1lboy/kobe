import { describe, expect, it, vi } from "vitest"
import { chooseTurnModel, parseModelRouterChoice } from "../../src/engine/ai-sdk/model-router"
import type { EngineCapabilities } from "../../src/types/engine"

const caps: EngineCapabilities = {
  vendorId: "codex",
  label: "Codex",
  models: [
    { vendor: "codex", id: "codex-small", label: "small" },
    { vendor: "codex", id: "codex-large", label: "large", effort: "high" },
    { vendor: "claude", id: "claude-cross", label: "cross" },
  ],
  permissionModes: [],
  defaultModelId: () => "codex-small",
  contextWindowFor: () => 0,
  smallFastModelId: () => "codex-small",
}

describe("parseModelRouterChoice", () => {
  it("accepts plain text and json model choices", () => {
    expect(parseModelRouterChoice("codex-large")).toEqual({ id: "codex-large" })
    expect(parseModelRouterChoice('{"model":"codex-large","effort":"high"}')).toEqual({
      id: "codex-large",
      effort: "high",
    })
  })
})

describe("chooseTurnModel", () => {
  it("does not call the small model when auto routing is disabled", async () => {
    const callSmallModel = vi.fn()
    const current = { vendor: "codex" as const, id: "codex-large", effort: "high" as const }
    await expect(
      chooseTurnModel({
        vendor: "codex",
        prompt: "fix it",
        history: [],
        current,
        capabilities: caps,
        autoModelEnabled: false,
        callSmallModel,
      }),
    ).resolves.toEqual(current)
    expect(callSmallModel).not.toHaveBeenCalled()
  })

  it("accepts a same-provider catalog choice returned by the small model", async () => {
    await expect(
      chooseTurnModel({
        vendor: "codex",
        prompt: "fix it",
        history: [],
        current: undefined,
        capabilities: caps,
        autoModelEnabled: true,
        callSmallModel: async () => '{"model":"codex-large","effort":"high"}',
      }),
    ).resolves.toEqual({ vendor: "codex", id: "codex-large", effort: "high" })
  })

  it("does not call the small model when there is only one same-provider candidate", async () => {
    const callSmallModel = vi.fn()
    await expect(
      chooseTurnModel({
        vendor: "codex",
        prompt: "fix it",
        history: [],
        current: undefined,
        capabilities: { ...caps, models: [{ vendor: "codex", id: "codex-small", label: "small" }] },
        autoModelEnabled: true,
        callSmallModel,
      }),
    ).resolves.toEqual({ vendor: "codex", id: "codex-small", effort: undefined })
    expect(callSmallModel).not.toHaveBeenCalled()
  })

  it("falls back when the small model returns a cross-provider or unknown model", async () => {
    const current = { vendor: "codex" as const, id: "codex-small" }
    await expect(
      chooseTurnModel({
        vendor: "codex",
        prompt: "fix it",
        history: [],
        current,
        capabilities: caps,
        autoModelEnabled: true,
        callSmallModel: async () => "claude-cross",
      }),
    ).resolves.toEqual(current)

    await expect(
      chooseTurnModel({
        vendor: "codex",
        prompt: "fix it",
        history: [],
        current,
        capabilities: caps,
        autoModelEnabled: true,
        callSmallModel: async () => "not-in-catalog",
      }),
    ).resolves.toEqual(current)
  })

  it("falls back when the small model call fails", async () => {
    const current = { vendor: "codex" as const, id: "codex-small" }
    await expect(
      chooseTurnModel({
        vendor: "codex",
        prompt: "fix it",
        history: [],
        current,
        capabilities: caps,
        autoModelEnabled: true,
        callSmallModel: async () => {
          throw new Error("router down")
        },
      }),
    ).resolves.toEqual(current)
  })
})
