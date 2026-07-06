import type { EngineCapabilities, EngineIdentity } from "@/types/engine"

export const CODEX_DEFAULT_MODEL = "gpt-5.3-codex"

export const codexCapabilities: EngineCapabilities = {
  vendorId: "codex",
  label: "Codex",
  models: [{ vendor: "codex", id: CODEX_DEFAULT_MODEL, label: "Codex default" }],
  permissionModes: [],
  defaultModelId: () => CODEX_DEFAULT_MODEL,
  contextWindowFor: () => 0,
}

export const codexIdentity: EngineIdentity = {
  vendorId: "codex",
  productName: "Codex",
  shortName: "Codex",
  assistantName: "Codex",
  inputPlaceholder: "Ask Codex…",
}
