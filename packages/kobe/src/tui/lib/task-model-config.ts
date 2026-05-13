import type { ModelEffortLevel } from "../../types/engine.ts"
import type { ChatTab, Task, VendorId } from "../../types/task.ts"
import type { KVContext } from "../context/kv"

export type InitialChatModelConfig = {
  readonly model?: string
  readonly modelEffort?: ModelEffortLevel
  readonly vendor?: VendorId
}

const LAST_ACTIVE_CHAT_MODEL_CONFIG_KEY = "lastActiveChatModelConfig"

export function initialChatModelConfig(task: Task | undefined, kv: KVContext): InitialChatModelConfig {
  const current = modelConfigFromTask(task)
  if (current) {
    kv.set(LAST_ACTIVE_CHAT_MODEL_CONFIG_KEY, current)
    return current
  }
  return parsePersistedModelConfig(kv.get(LAST_ACTIVE_CHAT_MODEL_CONFIG_KEY)) ?? {}
}

function modelConfigFromTask(task: Task | undefined): InitialChatModelConfig | null {
  if (!task) return null
  const tab = task.tabs.find((t) => t.id === task.activeTabId) ?? task.tabs[0]
  if (!tab) return null
  const config = modelConfigFromTab(task, tab)
  return hasModelConfig(config) ? config : null
}

function modelConfigFromTab(task: Task, tab: ChatTab): InitialChatModelConfig {
  return {
    model: tab.model ?? task.model,
    modelEffort: tab.modelEffort ?? task.modelEffort,
    vendor: tab.vendor ?? task.vendor,
  }
}

function parsePersistedModelConfig(value: unknown): InitialChatModelConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const config: InitialChatModelConfig = {
    model: typeof raw.model === "string" && raw.model.length > 0 ? raw.model : undefined,
    modelEffort: isModelEffort(raw.modelEffort) ? raw.modelEffort : undefined,
    vendor: isVendor(raw.vendor) ? raw.vendor : undefined,
  }
  return hasModelConfig(config) ? config : null
}

function hasModelConfig(config: InitialChatModelConfig): boolean {
  return config.model !== undefined || config.modelEffort !== undefined || config.vendor !== undefined
}

function isVendor(value: unknown): value is VendorId {
  return value === "claude" || value === "codex"
}

function isModelEffort(value: unknown): value is ModelEffortLevel {
  return (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  )
}
