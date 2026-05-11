/**
 * Engine-capabilities registry — the seam that lets neutral layers
 * (orchestrator, TUI) ask "what does vendor X offer?" without importing
 * any vendor adapter directly.
 *
 * The registry holds *capabilities only* (pure descriptors), not live
 * `AIEngine` instances. Live engine instances are constructed in
 * `tui/engine-bootstrap.ts` (or `core/index.ts`) and threaded through
 * via DI — capabilities are static enough that hard-coding them here is
 * fine and avoids forcing every caller to also depend on the
 * orchestrator.
 *
 * Two access shapes exposed:
 *   - `getCapabilities(vendor)` — when caller already knows the vendor
 *     (e.g. orchestrator forwards `task.vendor`).
 *   - `capabilitiesForModelId(modelId)` — when caller only has the
 *     stored model id and needs to recover the vendor (e.g. context
 *     meter, model-label formatter). Scans each vendor's catalog;
 *     unknown ids fall back to {@link defaultCapabilities}.
 *
 * `defaultCapabilities` is the vendor consulted when nothing else is
 * available (no vendor on Task, no match in any catalog). Claude
 * remains the kobe-preferred default until the codex adapter lands.
 */

import type { AIEngine, EngineCapabilities, ModelChoice } from "@/types/engine"
import type { VendorId } from "@/types/vendor"
import { claudeCapabilities } from "./claude-code-local/capabilities"
import { codexCapabilities } from "./codex-local/capabilities"

/**
 * Runtime engine map — vendor → live `AIEngine` instance.
 *
 * The orchestrator consumes this to route per-task work to the right
 * adapter. Built by `tui/engine-bootstrap.ts` (or `core/index.ts`)
 * at boot. Not the same as {@link ENGINE_REGISTRY} (which is static
 * capabilities only) — engine instances hold subprocess state and
 * MUST stay singletons per vendor.
 *
 * Partial because a kobe build might not have every vendor's binary
 * available; the orchestrator falls back to a registered default when
 * a task names an unregistered vendor.
 */
export type EngineMap = Readonly<Partial<Record<VendorId, AIEngine>>>

type Registry = Partial<Record<VendorId, EngineCapabilities>>

export const ENGINE_REGISTRY: Registry = {
  claude: claudeCapabilities,
  codex: codexCapabilities,
}

export const defaultCapabilities: EngineCapabilities = claudeCapabilities

export function getCapabilities(vendor: VendorId): EngineCapabilities {
  return ENGINE_REGISTRY[vendor] ?? defaultCapabilities
}

/**
 * Recover the right vendor capabilities for a stored model id. Used by
 * code paths that only have the model id (e.g. context-meter takes a
 * `Task.model` string). Falls back to {@link defaultCapabilities} when
 * the id doesn't appear in any catalog — keeps the meter rendering
 * something rather than blanking on an unrecognised pin.
 */
export function capabilitiesForModelId(modelId: string | undefined): EngineCapabilities {
  if (!modelId) return defaultCapabilities
  for (const caps of Object.values(ENGINE_REGISTRY)) {
    if (!caps) continue
    if (caps.models.some((m) => m.id === modelId)) return caps
  }
  return defaultCapabilities
}

/**
 * Flat list of every model surfaced by every registered vendor — the
 * source for the composer's model picker.
 */
export function allModels(): readonly ModelChoice[] {
  const seen = new Set<string>()
  const out: ModelChoice[] = []
  for (const caps of Object.values(ENGINE_REGISTRY)) {
    if (!caps) continue
    for (const m of caps.models) {
      const key = `${m.vendor}:${m.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(m)
    }
  }
  return out
}

/**
 * Pretty label for any stored model id. Looks the id up across every
 * vendor catalog; falls back to the id verbatim so the composer footer
 * always renders *something* meaningful, even for ids pinned outside
 * the picker shortlist.
 */
export function modelLabelFor(modelId: string | undefined): string {
  const resolved = modelId ?? defaultCapabilities.defaultModelId()
  for (const caps of Object.values(ENGINE_REGISTRY)) {
    if (!caps) continue
    const match = caps.models.find((m) => m.id === resolved)
    if (match) return match.label
  }
  return resolved
}
