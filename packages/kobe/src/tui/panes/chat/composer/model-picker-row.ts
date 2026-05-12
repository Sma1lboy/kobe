import { getCapabilities } from "@/engine/registry"
import type { ModelChoice } from "@/types/engine"

export type ModelPickerRowParts = {
  readonly level: string
  readonly vendor: string
  readonly engine: string
  readonly from: "catalog"
  readonly model: string
  readonly hint?: string
}

export function modelPickerRowParts(choice: ModelChoice): ModelPickerRowParts {
  const caps = getCapabilities(choice.vendor)
  return {
    level: choice.level ?? "level1",
    vendor: choice.vendor,
    engine: caps.label,
    from: "catalog",
    model: choice.label,
    hint: choice.hint,
  }
}

export function modelPickerMetaLabel(parts: ModelPickerRowParts): string {
  return `${parts.level} ${parts.vendor} ${parts.engine} from ${parts.from}`
}
