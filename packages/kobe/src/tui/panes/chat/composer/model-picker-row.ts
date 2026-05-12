import type { ModelChoice, ModelEffortLevel } from "@/types/engine"

export type ModelPickerModelOption = {
  readonly vendor: ModelChoice["vendor"]
  readonly id: string
  readonly label: string
  readonly hint?: string
  readonly choices: readonly ModelChoice[]
}

export type ModelPickerEffortOption = {
  readonly id: string
  readonly effort?: ModelEffortLevel
  readonly label: string
  readonly hint?: string
}

export function modelPickerModelOptions(choices: readonly ModelChoice[]): readonly ModelPickerModelOption[] {
  const byKey = new Map<string, ModelChoice[]>()
  for (const choice of choices) {
    const key = `${choice.vendor}:${choice.id}`
    const bucket = byKey.get(key)
    if (bucket) bucket.push(choice)
    else byKey.set(key, [choice])
  }

  return [...byKey.values()].map((bucket) => {
    const base = bucket.find((choice) => choice.effort === undefined) ?? bucket[0]
    if (!base) {
      throw new Error("model picker option bucket unexpectedly empty")
    }
    return {
      vendor: base.vendor,
      id: base.id,
      label: stripEffortSuffix(base.label, base.effort),
      hint: base.hint,
      choices: bucket,
    }
  })
}

export function modelPickerEffortOptions(model: ModelPickerModelOption): readonly ModelPickerEffortOption[] {
  return model.choices.map((choice) => ({
    id: choice.id,
    effort: choice.effort,
    label: choice.effort ?? "default",
    hint: choice.effort ? choice.hint : (choice.hint ?? "use the model default"),
  }))
}

function stripEffortSuffix(label: string, effort: ModelEffortLevel | undefined): string {
  if (!effort) return label
  return label.replace(new RegExp(`\\s+·\\s+${escapeRegExp(effort)}$`), "")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
