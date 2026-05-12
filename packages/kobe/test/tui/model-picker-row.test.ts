import { describe, expect, test } from "vitest"
import { modelLabelFor } from "../../src/engine/registry"
import {
  modelPickerEffortOptions,
  modelPickerMetaLabel,
  modelPickerModelOptions,
  modelPickerRowParts,
} from "../../src/tui/panes/chat/composer/model-picker-row"
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

  test("collapses model-bound effort variants into one model row", () => {
    const choices: ModelChoice[] = [
      {
        vendor: "codex",
        id: "gpt-5.5",
        label: "GPT-5.5",
        hint: "latest",
      },
      {
        vendor: "codex",
        id: "gpt-5.5",
        effort: "low",
        label: "GPT-5.5 · low",
        hint: "low reasoning",
      },
      {
        vendor: "codex",
        id: "gpt-5.4-mini",
        label: "GPT-5.4 mini",
      },
    ]

    const models = modelPickerModelOptions(choices)

    expect(models.map((m) => m.label)).toEqual(["GPT-5.5", "GPT-5.4 mini"])
    expect(models[0]?.choices).toHaveLength(2)
  })

  test("lists effort choices separately after a model is selected", () => {
    const [model] = modelPickerModelOptions([
      {
        vendor: "claude",
        id: "claude-opus-4-7",
        label: "Opus 4.7",
      },
      {
        vendor: "claude",
        id: "claude-opus-4-7",
        effort: "high",
        label: "Opus 4.7 · high",
        hint: "high effort",
      },
    ])

    expect(model).toBeDefined()
    const efforts = modelPickerEffortOptions(model!)

    expect(efforts).toEqual([
      { id: "claude-opus-4-7", effort: undefined, label: "default", hint: "use the model default" },
      { id: "claude-opus-4-7", effort: "high", label: "high", hint: "high effort" },
    ])
  })

  test("composer model label includes the selected effort", () => {
    expect(modelLabelFor("gpt-5.5", "xhigh")).toBe("GPT-5.5 · xhigh")
    expect(modelLabelFor("claude-opus-4-7", "max")).toBe("Opus 4.7 · max")
  })
})
