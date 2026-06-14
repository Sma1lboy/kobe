/**
 * EngineEffortPicker — the engine-owned vendor picker plus a reasoning/effort
 * control, shared by the Issues page's start surfaces. The engine chip grid
 * reads the same useEngines list every vendor picker does (CLAUDE.md:
 * engine-owned UI data, never hard-coded vendor strings).
 *
 * Some engines expose discrete effort levels (`/api/engines` carries
 * `effortLevels` from the registry — codex maps a level to
 * `-c model_reasoning_effort=<level>`; claude has none). When the SELECTED
 * engine has levels we render a segmented control under the grid; engines
 * without levels hide it entirely. Controlled via { vendor, effort, onChange }.
 */

import { useEffect, useState } from "react"
import { type EngineOption, engineLabel, useEngines } from "../lib/engines.ts"

/** The engine's effort levels off the shared EngineOption (now carries them
 *  natively from /api/engines), defaulting to an empty list. */
function effortLevelsOf(engine: EngineOption | undefined): readonly string[] {
  const levels = engine?.effortLevels
  return Array.isArray(levels) ? levels : []
}

/** A sensible default level for a freshly-picked engine: prefer "medium" when
 *  offered, else the middle of the list, else the first. */
function defaultEffort(levels: readonly string[]): string | undefined {
  if (levels.length === 0) return undefined
  if (levels.includes("medium")) return "medium"
  return levels[Math.floor(levels.length / 2)] ?? levels[0]
}

export function EngineEffortPicker({
  vendor,
  effort,
  onChange,
  disabled = false,
}: {
  vendor: string | undefined
  effort: string | undefined
  onChange: (next: { vendor: string; effort: string | undefined }) => void
  disabled?: boolean
}) {
  const engines = useEngines()
  const [seeded, setSeeded] = useState(false)

  // Seed the vendor from the first engine the bridge reports once, unless the
  // caller already picked one. (The standalone Issues page has no Settings
  // default route — the first /api/engines entry is the detected default.)
  useEffect(() => {
    if (vendor || seeded || engines.length === 0) return
    const next = engines[0]?.id
    if (!next) return
    setSeeded(true)
    onChange({
      vendor: next,
      effort: defaultEffort(effortLevelsOf(engines.find((e) => e.id === next))),
    })
  }, [vendor, seeded, engines, onChange])

  const selected = engines.find((e) => e.id === vendor)
  const levels = effortLevelsOf(selected)

  const pickVendor = (id: string): void => {
    const nextLevels = effortLevelsOf(engines.find((e) => e.id === id))
    // Keep the current effort if the new engine still offers it; otherwise seed.
    const nextEffort =
      effort && nextLevels.includes(effort) ? effort : defaultEffort(nextLevels)
    onChange({ vendor: id, effort: nextEffort })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
          Engine
        </span>
        <div className="flex flex-wrap gap-1.5">
          {engines.map((engine) => (
            <button
              key={engine.id}
              type="button"
              disabled={disabled}
              onClick={() => pickVendor(engine.id)}
              className={`border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                vendor === engine.id
                  ? "border-primary bg-inset text-fg"
                  : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
              }`}
            >
              {engineLabel(engines, engine.id)}
            </button>
          ))}
        </div>
      </div>

      {levels.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
            Effort
          </span>
          <div className="flex flex-wrap items-center overflow-hidden rounded-sm border border-line">
            {levels.map((level, i) => (
              <button
                key={level}
                type="button"
                disabled={disabled}
                onClick={() => vendor && onChange({ vendor, effort: level })}
                className={`px-2 py-0.5 text-[11px] capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  i > 0 ? "border-l border-line" : ""
                } ${
                  effort === level
                    ? "bg-inset text-fg"
                    : "bg-bg text-muted hover:text-fg"
                }`}
              >
                {level}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
