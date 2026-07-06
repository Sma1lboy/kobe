/**
 * Codex adapter capabilities for the native AI SDK harness path.
 *
 * The harness-codex adapter pins its default model when the caller leaves
 * `model` unset; mirror that value here so the composer footer can display an
 * engine-owned label without inventing UI-side Codex strings.
 */

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
