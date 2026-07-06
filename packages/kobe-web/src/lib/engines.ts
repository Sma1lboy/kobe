/**
 * Engine-owned vendor list, served by the bridge (GET /api/engines) from the
 * kobe engine registry: detected built-ins + user-registered custom engines,
 * labeled with their (possibly user-overridden) display names. The SPA must
 * never hard-code vendor string literals (CLAUDE.md: engine-owned UI data) —
 * every vendor picker reads this hook instead.
 *
 * Fetched once per page load and cached module-level; the fallback keeps the
 * pickers usable against an older bridge that predates the route.
 */

import { api } from "./api-client.ts"
import { createExternalStore } from "./external-store.ts"

export interface EngineOption {
  id: string
  label: string
  /** Reasoning/effort levels this engine accepts (e.g. `["low","medium",
   *  "high"]`), engine-owned and served per vendor. codex maps a level to
   *  `-c model_reasoning_effort=<level>`; claude has none. Absent/empty when
   *  the engine exposes no effort control — the issue drawer hides the effort
   *  picker. */
  effortLevels?: readonly string[]
}

const FALLBACK: readonly EngineOption[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
]

const store = createExternalStore<readonly EngineOption[]>(FALLBACK)
let fetched = false

function ensureFetched(): void {
  if (fetched) return
  fetched = true
  void api
    .getOr<{ engines?: EngineOption[] }>(
      "/api/engines",
      {},
      { label: "load engines" },
    )
    .then((json) => {
      if (!Array.isArray(json.engines) || json.engines.length === 0) return
      store.replace(
        json.engines
          .filter(
            (e): e is EngineOption =>
              typeof e?.id === "string" && typeof e?.label === "string",
          )
          .map((e) => ({
            id: e.id,
            label: e.label,
            // Keep only a clean string[] when the engine ships effort levels;
            // drop the field entirely otherwise so callers can `?? []` cleanly.
            ...(Array.isArray(e.effortLevels) &&
            e.effortLevels.every((l) => typeof l === "string")
              ? { effortLevels: e.effortLevels }
              : {}),
          })),
      )
    })
    .catch(() => {
      /* fallback list stays */
    })
}

export function useEngines(): readonly EngineOption[] {
  ensureFetched()
  return store.useSnapshot()
}

// Vendor-identity rules (engineLabel, the unset-vendor default, the mixed-
// workspace aggregations, the per-row label rule) live in ./vendor.ts — this
// module's only job is fetching the engine-owned list from the bridge.
