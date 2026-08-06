/**
 * Shared building blocks of the Settings page — the Section group (uppercase
 * label + hairline, the sidebar's grouping grammar), the SwitchRow control,
 * and the load/patch hook over the per-user settings KV. Sections live in
 * SettingsSections.tsx; the single-column frame in SettingsPage.tsx.
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

/** One settings group: uppercase label + hairline rule, then borderless
 *  rows — the same grouping grammar the sidebar's project headers use. */
export function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-center gap-2 pb-2">
        <h2 className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
          {title}
        </h2>
        <span className="h-px min-w-0 flex-1 bg-line" />
      </div>
      <div className="space-y-1 text-[12px]">{children}</div>
    </section>
  )
}

/** Borderless label/control row — label + detail left, control right. */
export function Row({
  label,
  detail,
  children,
}: {
  label: string
  detail?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div className="text-[12px] text-fg">{label}</div>
        {detail ? (
          <div className="mt-0.5 text-[11px] leading-relaxed text-subtle">
            {detail}
          </div>
        ) : null}
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  )
}

/** Pill switch — the Routines toggle, reused as THE boolean control. */
export function Switch({
  enabled,
  onToggle,
  disabled,
  label,
}: {
  enabled: boolean
  onToggle: () => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={enabled}
      className={`h-3.5 w-6 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        enabled ? "border-primary bg-primary/60" : "border-line bg-inset"
      }`}
    >
      <span
        className={`block h-2.5 w-2.5 rounded-full bg-fg transition-transform ${
          enabled ? "translate-x-3" : "translate-x-0.5"
        }`}
      />
    </button>
  )
}

export function SwitchRow({
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
    <Row label={label} detail={detail}>
      <Switch
        enabled={enabled}
        onToggle={onToggle}
        disabled={disabled}
        label={label}
      />
    </Row>
  )
}

export const settingsInput =
  "border border-line bg-bg px-2 py-1 text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"

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
