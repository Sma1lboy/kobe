/**
 * Shared building blocks of the Settings page — the flat section Card, the
 * ToggleRow control, and the load/patch hook over the per-user settings KV.
 * Split from SettingsPage.tsx; the sections live in SettingsSections.tsx.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  fetchSettings,
  saveSettings,
  type WebSettings,
} from "../lib/settings.ts"
import { reportError } from "../lib/toast.ts"

/** The settings patch function every section receives from useSharedSettings. */
export type PatchSettings = (
  delta: Parameters<typeof saveSettings>[0],
) => Promise<WebSettings>

// A flat section: a BOLD CAPS header over its content, with NO enclosing
// border/fill. The controls inside (EngineRow, ToggleRow, inputs, textareas)
// already carry their own border, so wrapping them in a bordered card stacked a
// third concentric box (card → row → field) and read as over-nested. Dropping
// the card box leaves the header to group, the controls to delineate.
export function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[12px]">{children}</div>
    </section>
  )
}

export function ToggleRow({
  label,
  detail,
  enabled,
  onToggle,
  disabled,
}: {
  label: string
  detail?: string
  enabled: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 border border-line bg-bg p-3">
      <div className="min-w-0">
        <div className="text-[12px] font-bold text-fg">{label}</div>
        {detail ? (
          <div className="mt-1 text-[11px] leading-relaxed text-subtle">
            {detail}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className={`shrink-0 border px-2 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          enabled
            ? "border-primary bg-inset text-fg"
            : "border-line bg-surface text-muted hover:border-primary hover:text-fg"
        }`}
      >
        {enabled ? "On" : "Off"}
      </button>
    </div>
  )
}

export function useSharedSettings() {
  const [settings, setSettings] = useState<WebSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  // A failed load leaves `settings` null forever, so track the error
  // separately to show a retryable empty state instead of a stuck spinner.
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    setError(false)
    try {
      const next = await fetchSettings()
      if (seq === seqRef.current) setSettings(next)
    } catch (err) {
      if (seq === seqRef.current) setError(true)
      reportError("load settings", err)
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch: PatchSettings = async (delta) => {
    const next = await saveSettings(delta)
    setSettings(next)
    return next
  }

  return { settings, loading, error, reload: load, patch }
}
