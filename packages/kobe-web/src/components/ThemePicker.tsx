import { Check } from "lucide-react"
import {
  clearPreferredTheme,
  setPreferredTheme,
  useThemeState,
} from "../lib/theme.ts"

function Swatch({ palette }: { palette: Record<string, string> }) {
  const chips = [
    palette.bg,
    palette.primary,
    palette["kobe-blue"],
    palette["kobe-green"],
  ].filter(Boolean)
  return (
    <span className="flex shrink-0 overflow-hidden rounded border border-line">
      {chips.map((c, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed positional swatch chips
          key={i}
          className="h-5 w-3"
          style={{ backgroundColor: c }}
        />
      ))}
    </span>
  )
}

export function ThemePicker() {
  const { names, palettes, active, overridden } = useThemeState()

  return (
    <div className="border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
          Appearance
        </div>
        {overridden ? (
          <button
            type="button"
            onClick={clearPreferredTheme}
            className="border border-line bg-bg px-2 py-0.5 text-[10px] text-muted transition-colors hover:border-primary hover:text-fg"
            title="Clear the web-local theme and follow the TUI again"
          >
            Follow TUI
          </button>
        ) : (
          <span className="font-mono text-[10px] text-subtle">
            following TUI
          </span>
        )}
      </div>
      {names.length === 0 ? (
        <p className="mt-4 text-[12px] text-subtle">Loading themes…</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {names.map((name) => {
            const isActive = name === active
            return (
              <button
                key={name}
                type="button"
                onClick={() => setPreferredTheme(name)}
                className={`flex items-center gap-2 border px-2 py-1.5 text-left transition-colors ${
                  isActive
                    ? "border-primary bg-inset"
                    : "border-line bg-bg hover:border-primary"
                }`}
              >
                <Swatch palette={palettes[name] ?? {}} />
                <span
                  className={`min-w-0 flex-1 truncate text-[12px] ${isActive ? "text-fg" : "text-muted"}`}
                >
                  {name}
                </span>
                {isActive && (
                  <Check
                    size={13}
                    strokeWidth={2.5}
                    className="shrink-0 text-primary"
                  />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
