import type { ModelChoice, ModelEffortLevel } from "@/types/engine"
import type { VendorId } from "@/types/vendor"

export type ModelPickerModelOption = {
  readonly vendor: ModelChoice["vendor"]
  readonly id: string
  readonly label: string
  readonly hint?: string
  readonly disabled?: boolean
  readonly disabledReason?: string
  readonly choices: readonly ModelChoice[]
}

export type ModelPickerEffortOption = {
  readonly id: string
  readonly effort?: ModelEffortLevel
  readonly label: string
  readonly hint?: string
}

export type ModelPickerProviderGroup = {
  readonly vendor: VendorId
  readonly label: string
  readonly models: readonly ModelPickerModelOption[]
}

export function modelPickerModelOptions(
  choices: readonly ModelChoice[],
  opts: { lockedVendor?: VendorId } = {},
): readonly ModelPickerModelOption[] {
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
      disabled: opts.lockedVendor !== undefined && base.vendor !== opts.lockedVendor,
      disabledReason:
        opts.lockedVendor !== undefined && base.vendor !== opts.lockedVendor ? "new chat required" : undefined,
      choices: bucket,
    }
  })
}

export function modelPickerProviderGroups(
  choices: readonly ModelChoice[],
  opts: {
    lockedVendor?: VendorId
    providerLabels?: Partial<Record<VendorId, string>>
    providerLabelFor?: (vendor: VendorId) => string
  } = {},
): readonly ModelPickerProviderGroup[] {
  const models = modelPickerModelOptions(choices, { lockedVendor: opts.lockedVendor })
  const byVendor = new Map<VendorId, ModelPickerModelOption[]>()
  for (const model of models) {
    const bucket = byVendor.get(model.vendor)
    if (bucket) bucket.push(model)
    else byVendor.set(model.vendor, [model])
  }

  return [...byVendor.entries()].map(([vendor, vendorModels]) => ({
    vendor,
    label: opts.providerLabelFor?.(vendor) ?? opts.providerLabels?.[vendor] ?? vendor,
    models: vendorModels,
  }))
}

export function modelPickerDefaultExpandedVendors(
  currentVendor: VendorId | undefined,
  lockedVendor: VendorId | undefined,
): ReadonlySet<VendorId> {
  return new Set([currentVendor ?? lockedVendor ?? "claude"])
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
