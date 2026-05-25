import { describe, expect, test } from "vitest"
import { modelLabelFor } from "../../src/engine/registry"
import {
  modelPickerDefaultExpandedVendors,
  modelPickerEffortOptions,
  modelPickerModelOptions,
  modelPickerProviderGroups,
} from "../../src/tui/panes/chat/composer/model-picker-row"
import type { ModelChoice } from "../../src/types/engine"

describe("model picker option helpers", () => {
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

  test("marks cross-engine models disabled when a chat tab is engine-locked", () => {
    const models = modelPickerModelOptions(
      [
        {
          vendor: "claude",
          id: "claude-opus-4-7",
          label: "Opus 4.7",
        },
        {
          vendor: "codex",
          id: "gpt-5.5",
          label: "GPT-5.5",
        },
      ],
      { lockedVendor: "claude" },
    )

    expect(models).toEqual([
      expect.objectContaining({ id: "claude-opus-4-7", disabled: false, disabledReason: undefined }),
      expect.objectContaining({ id: "gpt-5.5", disabled: true, disabledReason: "new chat required" }),
    ])
  })

  test("groups model rows by provider using provider labels", () => {
    const groups = modelPickerProviderGroups(
      [
        {
          vendor: "claude",
          id: "claude-opus-4-7",
          label: "Opus 4.7",
        },
        {
          vendor: "codex",
          id: "gpt-5.5",
          label: "GPT-5.5",
        },
        {
          vendor: "codex",
          id: "gpt-5.5",
          effort: "xhigh",
          label: "GPT-5.5 · xhigh",
        },
      ],
      { providerLabels: { claude: "Claude Code", codex: "Codex" } },
    )

    expect(groups).toEqual([
      expect.objectContaining({
        vendor: "claude",
        label: "Claude Code",
        models: [expect.objectContaining({ id: "claude-opus-4-7" })],
      }),
      expect.objectContaining({
        vendor: "codex",
        label: "Codex",
        models: [
          expect.objectContaining({
            id: "gpt-5.5",
            choices: expect.arrayContaining([expect.objectContaining({ effort: "xhigh" })]),
          }),
        ],
      }),
    ])
  })

  test("defaults expansion to the current provider, then locked provider, then Claude", () => {
    expect([...modelPickerDefaultExpandedVendors("codex", "claude")]).toEqual(["codex"])
    expect([...modelPickerDefaultExpandedVendors(undefined, "gemini")]).toEqual(["gemini"])
    expect([...modelPickerDefaultExpandedVendors(undefined, undefined)]).toEqual(["claude"])
  })

  test("composer model label includes the selected effort", () => {
    expect(modelLabelFor("gpt-5.5", "xhigh")).toBe("GPT-5.5 · xhigh")
    expect(modelLabelFor("claude-opus-4-7", "max")).toBe("Opus 4.7 · max")
  })
})
