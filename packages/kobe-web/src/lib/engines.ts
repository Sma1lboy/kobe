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

import { useSyncExternalStore } from "react"

export interface EngineOption {
  id: string
  label: string
  /** Discrete reasoning/effort levels this engine exposes (from the registry,
   *  served on /api/engines). codex maps a level to
   *  `-c model_reasoning_effort=<level>`; claude has none. Absent/empty means
   *  the engine has no kobe-driveable effort control. */
  effortLevels?: readonly string[]
}

const FALLBACK: readonly EngineOption[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
]

let engines: readonly EngineOption[] = FALLBACK
let fetched = false
const listeners = new Set<() => void>()

function ensureFetched(): void {
  if (fetched) return
  fetched = true
  void fetch("/api/engines")
    .then(async (res) => {
      if (!res.ok) return
      const json = (await res.json()) as { engines?: EngineOption[] }
      if (!Array.isArray(json.engines) || json.engines.length === 0) return
      engines = json.engines
        .filter(
          (e): e is EngineOption =>
            typeof e?.id === "string" && typeof e?.label === "string",
        )
        .map((e) => ({
          id: e.id,
          label: e.label,
          ...(Array.isArray(e.effortLevels)
            ? {
                effortLevels: e.effortLevels.filter(
                  (l): l is string => typeof l === "string",
                ),
              }
            : {}),
        }))
      for (const l of listeners) l()
    })
    .catch(() => {
      /* fallback list stays */
    })
}

export function useEngines(): readonly EngineOption[] {
  ensureFetched()
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => engines,
    () => engines,
  )
}

/** Display label for a vendor id (falls back to the raw id). An unset id
 *  coalesces to the default "claude" and resolves through the registry just
 *  like an explicit "claude" — so an undefined-vendor task and an explicit
 *  vendor:"claude" task render the SAME label (and respect a user override),
 *  matching how distinctTaskVendors groups them. */
export function engineLabel(
  list: readonly EngineOption[],
  id: string | undefined,
): string {
  const resolved = id || "claude"
  return list.find((e) => e.id === resolved)?.label ?? resolved
}
