import {
  _resetOpenRouterModelCacheForTests,
  openRouterModelId,
  resolveOpenRouterContextWindow,
} from "@/engine/codex-local/openrouter"
import { afterEach, describe, expect, it, vi } from "vitest"

const originalFetch = globalThis.fetch

describe("OpenRouter context-window fallback", () => {
  afterEach(() => {
    _resetOpenRouterModelCacheForTests()
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("maps bare Codex model ids to OpenRouter OpenAI ids", () => {
    expect(openRouterModelId("gpt-5.5")).toBe("openai/gpt-5.5")
    expect(openRouterModelId("openai/gpt-5.5")).toBe("openai/gpt-5.5")
  })

  it("reads context_length from the public models response", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            { id: "openai/gpt-5.5", context_length: 1_050_000 },
            { id: "openai/gpt-5.4-mini", context_length: 400_000 },
          ],
        }),
      )
    }) as unknown as typeof fetch

    await expect(resolveOpenRouterContextWindow("gpt-5.5")).resolves.toBe(1_050_000)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it("fails closed when OpenRouter is unavailable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch

    await expect(resolveOpenRouterContextWindow("gpt-5.5")).resolves.toBeUndefined()
  })
})
