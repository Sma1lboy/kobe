import { getPersistedString } from "../state/repos.ts"
import type { VendorId } from "../types/vendor.ts"
import { engineEntry } from "./registry.ts"

export interface RunTurnEngineSettings {
  readonly model: string
  readonly smallModel: string
  readonly effort: string
  readonly effortLevels: readonly string[]
}

/** state.json key for a vendor's default headless runTurn model. */
export function runTurnModelKey(vendor: VendorId): string {
  return `runTurnModel.${vendor}`
}

/** state.json key for the vendor's small-model probe/router calls. */
export function runTurnSmallModelKey(vendor: VendorId): string {
  return `runTurnSmallModel.${vendor}`
}

/** state.json key for a vendor's runTurn reasoning/effort override. */
export function runTurnEffortKey(vendor: VendorId): string {
  return `runTurnEffort.${vendor}`
}

export function normalizeRunTurnEffort(vendor: VendorId, value: unknown): string {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  const levels = engineEntry(vendor).effortLevels ?? []
  return levels.includes(trimmed) ? trimmed : ""
}

function stateString(state: Record<string, unknown>, key: string): string {
  const value = state[key]
  return typeof value === "string" ? value.trim() : ""
}

export function runTurnSettingsFromState(state: Record<string, unknown>, vendor: VendorId): RunTurnEngineSettings {
  const effortLevels = engineEntry(vendor).effortLevels ?? []
  return {
    model: stateString(state, runTurnModelKey(vendor)),
    smallModel: stateString(state, runTurnSmallModelKey(vendor)),
    effort: normalizeRunTurnEffort(vendor, state[runTurnEffortKey(vendor)]),
    effortLevels,
  }
}

export function readRunTurnSettings(vendor: VendorId): RunTurnEngineSettings {
  const effortLevels = engineEntry(vendor).effortLevels ?? []
  return {
    model: getPersistedString(runTurnModelKey(vendor))?.trim() ?? "",
    smallModel: getPersistedString(runTurnSmallModelKey(vendor))?.trim() ?? "",
    effort: normalizeRunTurnEffort(vendor, getPersistedString(runTurnEffortKey(vendor))),
    effortLevels,
  }
}
