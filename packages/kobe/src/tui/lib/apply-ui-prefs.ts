/**
 * Pure "apply visual prefs" logic, shared by every pane host's boot AND
 * the live `ui-prefs` daemon channel (KOB — cross-session theme
 * propagation).
 *
 * One function decides how a `{ theme, transparentBackground, focusAccent }`
 * snapshot lands on the theme runtime, so the boot-time application and
 * every later live push behave identically in all hosts. Before this,
 * hosts drifted: tasks/settings/ops applied transparent + focus accent in
 * their own `onMount` while new-task / quick-task / update / ops-preview
 * only ever got the theme name — the central caller in
 * `tui/lib/host-boot.tsx` now routes all of them through here.
 *
 * The target is INJECTED (not `useTheme()` directly) for two reasons:
 *   - vitest-safety: `tui/context/theme.tsx` imports @opentui, which is
 *     not importable under node/vitest — this module must stay pure so
 *     the apply rules are unit-testable (same seam stance as
 *     `tmux-border-theme.ts`'s mirrored slot list);
 *   - echo-loop guard: the process that CAUSED a prefs write (the
 *     Settings dialog applied it locally already) receives its own push
 *     back from the daemon — every setter here is gated on a
 *     compare-with-current, so an identical payload is a strict no-op.
 */

/**
 * Mirror of `FOCUS_ACCENT_SLOTS` in `tui/context/theme.tsx` — not
 * imported because that module builds a Solid store on the renderer at
 * load time (see the identical mirror in `tui/lib/tmux-border-theme.ts`).
 */
export const UI_PREFS_FOCUS_ACCENT_SLOTS = ["primary", "success", "info"] as const
export type UiPrefsFocusAccentSlot = (typeof UI_PREFS_FOCUS_ACCENT_SLOTS)[number]

/** Default focus-accent slot when the pref is unset (`theme.tsx` default). */
export const DEFAULT_FOCUS_ACCENT_SLOT: UiPrefsFocusAccentSlot = "primary"

/** A visual-prefs snapshot, as loose as the wire/file can make it. */
export interface UiPrefsSnapshot {
  readonly theme?: unknown
  readonly transparentBackground?: unknown
  readonly focusAccent?: unknown
}

/**
 * The slice of the theme runtime the apply needs — `useTheme()` plus a
 * user-theme reload hook, adapted by the caller (host-boot wires the
 * real context; tests inject a fake).
 */
export interface UiPrefsTarget {
  selectedTheme(): string
  hasTheme(name: string): boolean
  setTheme(name: string): boolean
  /**
   * Re-scan `~/.kobe/themes/` into the registry. Called once when the
   * pushed theme name isn't registered in THIS process — e.g. the user
   * added a theme file and selected it from another session's Settings
   * after this pane booted.
   */
  reloadUserThemes(): void
  transparentBackground(): boolean
  setTransparentBackground(v: boolean): void
  focusAccent(): string
  setFocusAccent(slot: UiPrefsFocusAccentSlot): void
}

/**
 * Apply a prefs snapshot onto the theme runtime. Field-by-field,
 * changed-only (identical values touch nothing — the echo guard):
 *
 *   - **theme** — switch when the name differs from the current
 *     selection. An unregistered name triggers ONE user-theme reload;
 *     still unknown after that → keep the current theme (never blind-
 *     fall back to the default and yank a working pane to `claude`
 *     because another process persisted a name this build doesn't have).
 *   - **transparentBackground** — applied when it's a real boolean that
 *     differs.
 *   - **focusAccent** — validated against the known slots; `null` (the
 *     persisted "unset") converges on the default slot.
 *
 * Absent/malformed fields are skipped, never defaulted-and-applied, so a
 * partial snapshot can't reset prefs it didn't carry.
 */
export function applyUiPrefs(target: UiPrefsTarget, prefs: UiPrefsSnapshot): void {
  if (typeof prefs.theme === "string" && prefs.theme.length > 0 && prefs.theme !== target.selectedTheme()) {
    if (!target.hasTheme(prefs.theme)) target.reloadUserThemes()
    if (target.hasTheme(prefs.theme)) target.setTheme(prefs.theme)
  }

  if (
    typeof prefs.transparentBackground === "boolean" &&
    prefs.transparentBackground !== target.transparentBackground()
  ) {
    target.setTransparentBackground(prefs.transparentBackground)
  }

  if (prefs.focusAccent === null || typeof prefs.focusAccent === "string") {
    const slot = normalizeFocusAccent(prefs.focusAccent)
    if (slot && slot !== target.focusAccent()) target.setFocusAccent(slot)
  }
}

/**
 * `null` → the default slot (persisted "unset"); a known slot passes
 * through; an unknown string → `null` (skip — don't guess).
 */
export function normalizeFocusAccent(value: string | null): UiPrefsFocusAccentSlot | null {
  if (value === null) return DEFAULT_FOCUS_ACCENT_SLOT
  return (UI_PREFS_FOCUS_ACCENT_SLOTS as readonly string[]).includes(value) ? (value as UiPrefsFocusAccentSlot) : null
}
