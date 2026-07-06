import type { ContentBlock } from "./content"
import type { VendorId } from "./vendor"
export type { ContentBlock } from "./content"

export type ModelChoice = {
  readonly vendor: VendorId
  readonly id: string
  readonly effort?: ModelEffortLevel
  readonly level?: string
  readonly label: string
  readonly hint?: string
}

export type ModelEffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export type PermissionMode = "default" | "acceptEdits" | "plan"

export interface PermissionModeChoice {
  readonly id: PermissionMode
  readonly label: string
}

export interface EngineCapabilities {
  readonly vendorId: VendorId
  readonly label: string
  readonly models: readonly ModelChoice[]
  readonly permissionModes: readonly PermissionModeChoice[]
  defaultModelId(): string
  contextWindowFor(modelId: string): number
  smallFastModelId?(): string | undefined
}

export interface EngineIdentity {
  readonly vendorId: VendorId
  readonly productName: string
  readonly shortName: string
  readonly assistantName: string
  readonly inputPlaceholder: string
}

export interface Message {
  readonly role: "user" | "assistant" | "system"
  readonly blocks: readonly ContentBlock[]
  readonly timestamp: string
  readonly sessionId: string
  readonly usage?: {
    readonly input_tokens: number
    readonly output_tokens: number
    readonly cache_read_input_tokens?: number
    readonly cache_creation_input_tokens?: number
  }
}

export type EngineUsageSnapshot = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly context_tokens?: number
  readonly context_tokens_approximate?: boolean
  readonly context_window_tokens?: number
  readonly total_speed_tokens_per_second?: number
}

export interface EngineHistory {
  readonly messages: readonly Message[]
  readonly usageMetrics?: EngineUsageSnapshot
}
