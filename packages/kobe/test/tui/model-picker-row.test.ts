import { describe, expect, test } from "vitest"
import { modelPickerMetaLabel, modelPickerRowParts } from "../../src/tui/panes/chat/composer/model-picker-row"
import type { ModelChoice } from "../../src/types/engine"

describe("modelPickerRowParts", () => {
  test("formats claude rows as level/vendor/engine/from before model", () => {
    const choice: ModelChoice = {
      vendor: "claude",
      id: "claude-opus-4-7[1m]",
      label: "Opus 4.7 1M",
      hint: "long context",
    }

    const parts = modelPickerRowParts(choice)

    expect(modelPickerMetaLabel(parts)).toBe("level1 claude Claude Code from catalog")
    expect(parts.model).toBe("Opus 4.7 1M")
    expect(parts.hint).toBe("long context")
  })

  test("formats codex rows with the codex engine label before model", () => {
    const choice: ModelChoice = {
      vendor: "codex",
      id: "gpt-5.5",
      label: "GPT-5.5",
    }

    const parts = modelPickerRowParts(choice)

    expect(modelPickerMetaLabel(parts)).toBe("level1 codex Codex from catalog")
    expect(parts.model).toBe("GPT-5.5")
  })

  test("uses model-bound effort level when present", () => {
    const choice: ModelChoice = {
      vendor: "codex",
      id: "gpt-5.5",
      effort: "xhigh",
      level: "xhigh",
      label: "GPT-5.5 · xhigh",
    }

    const parts = modelPickerRowParts(choice)

    expect(modelPickerMetaLabel(parts)).toBe("xhigh codex Codex from catalog")
    expect(parts.model).toBe("GPT-5.5 · xhigh")
  })
})
