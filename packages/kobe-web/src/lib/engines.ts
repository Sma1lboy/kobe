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
  /** Reasoning/effort levels this engine accepts (e.g. `["low","medium",
   *  "high"]`), engine-owned and served per vendor. Absent when the engine
   *  exposes no effort control — the issue drawer hides the effort picker. */
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
          // Keep only a clean string[] when the engine ships effort levels;
          // drop the field entirely otherwise so callers can `?? []` cleanly.
          ...(Array.isArray(e.effortLevels) &&
          e.effortLevels.every((l) => typeof l === "string")
            ? { effortLevels: e.effortLevels }
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

/** Display label for a vendor id (falls back to the raw id). */
export function engineLabel(
  list: readonly EngineOption[],
  id: string | undefined,
): string {
  if (!id) return "claude"
  return list.find((e) => e.id === id)?.label ?? id
}
