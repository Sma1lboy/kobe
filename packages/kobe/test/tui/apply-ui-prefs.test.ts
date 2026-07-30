/**
 * applyUiPrefs (KOB — live theme propagation). Why these tests matter:
 * this one function is BOTH the boot-time prefs application for every pane
 * host and the handler for every live `ui-prefs` daemon push, so its rules
 * carry two regressions waiting to happen:
 *
 *   - **echo loop**: the process that caused a prefs write receives its
 *     own push back ~half a second later — identical values MUST touch
 *     nothing, or the settings dialog's own pane re-applies forever;
 *   - **unknown theme**: a theme installed + selected from ANOTHER process
 *     after this pane booted isn't in this pane's registry — the apply
 *     must reload user themes once and only switch when the name resolves,
 *     never blind-fall back and yank a working pane to the default.
 *
 * Tested through an injected fake target — `tui/context/theme.tsx` itself
 * imports @opentui, which is not importable under node/vitest (the reason
 * the apply logic lives in the vitest-safe `tui/lib/apply-ui-prefs.ts`).
 */

import { describe, expect, test } from "vitest"
import {
  DEFAULT_FOCUS_ACCENT_SLOT,
  type UiPrefsTarget,
  applyUiPrefs,
  normalizeFocusAccent,
} from "../../src/tui/lib/apply-ui-prefs.ts"

interface FakeState {
  theme: string
  registry: Set<string>
  /** Themes that become registered when reloadUserThemes() runs. */
  diskThemes: string[]
  transparent: boolean
  accent: string
}

function makeTarget(initial?: Partial<FakeState>) {
  const state: FakeState = {
    theme: "claude",
    registry: new Set(["claude", "nord"]),
    diskThemes: [],
    transparent: false,
    accent: "primary",
    ...initial,
  }
  const calls: string[] = []
  const target: UiPrefsTarget = {
    selectedTheme: () => state.theme,
    hasTheme: (name) => state.registry.has(name),
    setTheme: (name) => {
      calls.push(`setTheme:${name}`)
      if (!state.registry.has(name)) return false
      state.theme = name
      return true
    },
    reloadUserThemes: () => {
      calls.push("reloadUserThemes")
      for (const name of state.diskThemes) state.registry.add(name)
    },
    transparentBackground: () => state.transparent,
    setTransparentBackground: (v) => {
      calls.push(`setTransparentBackground:${v}`)
      state.transparent = v
    },
    focusAccent: () => state.accent,
    setFocusAccent: (slot) => {
      calls.push(`setFocusAccent:${slot}`)
      state.accent = slot
    },
  }
  return { state, calls, target }
}

describe("applyUiPrefs", () => {
  test("identical payload is a strict no-op (the echo-loop guard)", () => {
    const { calls, target } = makeTarget({ theme: "nord", transparent: true, accent: "info" })
    applyUiPrefs(target, { theme: "nord", transparentBackground: true, focusAccent: "info" })
    expect(calls).toEqual([])
  })

  test("applies all three prefs when they differ", () => {
    const { state, calls, target } = makeTarget()
    applyUiPrefs(target, { theme: "nord", transparentBackground: true, focusAccent: "success" })
    expect(calls).toEqual(["setTheme:nord", "setTransparentBackground:true", "setFocusAccent:success"])
    expect(state).toMatchObject({ theme: "nord", transparent: true, accent: "success" })
  })

  test("unknown theme triggers ONE user-theme reload, then switches when it resolves", () => {
    const { state, calls, target } = makeTarget({ diskThemes: ["osaka-jade"] })
    applyUiPrefs(target, { theme: "osaka-jade" })
    expect(calls).toEqual(["reloadUserThemes", "setTheme:osaka-jade"])
    expect(state.theme).toBe("osaka-jade")
  })

  test("theme still unknown after the reload keeps the current theme (no fallback yank)", () => {
    const { state, calls, target } = makeTarget()
    applyUiPrefs(target, { theme: "does-not-exist" })
    expect(calls).toEqual(["reloadUserThemes"])
    expect(state.theme).toBe("claude")
  })

  test("focusAccent null (persisted 'unset') converges on the default slot", () => {
    const { calls, target } = makeTarget({ accent: "info" })
    applyUiPrefs(target, { focusAccent: null })
    expect(calls).toEqual([`setFocusAccent:${DEFAULT_FOCUS_ACCENT_SLOT}`])
  })

  test("unknown focusAccent slot is skipped, not guessed", () => {
    const { calls, target } = makeTarget({ accent: "info" })
    applyUiPrefs(target, { focusAccent: "chartreuse" })
    expect(calls).toEqual([])
  })

  test("absent / malformed fields are skipped — a partial snapshot can't reset prefs it didn't carry", () => {
    const { calls, target } = makeTarget({ theme: "nord", transparent: true, accent: "info" })
    applyUiPrefs(target, {})
    applyUiPrefs(target, { theme: 42, transparentBackground: "yes" })
    expect(calls).toEqual([])
  })
})

describe("normalizeFocusAccent", () => {
  test("null → default slot; known slot passes; unknown → null", () => {
    expect(normalizeFocusAccent(null)).toBe(DEFAULT_FOCUS_ACCENT_SLOT)
    expect(normalizeFocusAccent("info")).toBe("info")
    expect(normalizeFocusAccent("chartreuse")).toBeNull()
  })
})
