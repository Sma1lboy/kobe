import { useEffect, useState } from "react"
import { type EngineOption, useEngines } from "../lib/engines.ts"
import { fetchDefaultEngine } from "../lib/settings.ts"
import { engineLabel } from "../lib/vendor.ts"

function effortLevelsOf(engine: EngineOption | undefined): readonly string[] {
  const levels = engine?.effortLevels
  return Array.isArray(levels) ? levels : []
}

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

  useEffect(() => {
    if (vendor || seeded) return
    let cancelled = false
    void fetchDefaultEngine().then((id) => {
      if (cancelled) return
      setSeeded(true)
      const next = id ?? engines[0]?.id
      if (next)
        onChange({
          vendor: next,
          effort: defaultEffort(
            effortLevelsOf(engines.find((e) => e.id === next)),
          ),
        })
    })
    return () => {
      cancelled = true
    }
  }, [vendor, seeded, engines, onChange])

  const selected = engines.find((e) => e.id === vendor)
  const levels = effortLevelsOf(selected)

  const pickVendor = (id: string): void => {
    const nextLevels = effortLevelsOf(engines.find((e) => e.id === id))
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
