import { describe, expect, test } from "vitest"
import { renderPRPrompt } from "../../src/tui/ops/pr-prompt"

describe("renderPRPrompt", () => {
  test("renders the built-in git state placeholders", () => {
    const text = renderPRPrompt("{{dirtyCountSentence}} {{branch}} -> {{targetBranch}}. {{upstreamSentence}}", {
      branch: "feature/x",
      targetBranch: "main",
      hasUpstream: false,
      dirtyCount: 2,
    })
    expect(text).toBe("There are 2 uncommitted changes. feature/x -> main. There is no upstream branch yet.")
  })

  test("leaves unknown placeholders literal for user templates", () => {
    const text = renderPRPrompt("{{branch}} {{unknownThing}}", {
      branch: "feature/x",
      targetBranch: "main",
      hasUpstream: true,
      dirtyCount: 0,
    })
    expect(text).toBe("feature/x {{unknownThing}}")
  })
})
