/**
 * Unit tests for the tmux-layer keybinding resolver
 * (`src/tmux/keybindings.ts`) — the `tmux.*` half of
 * `~/.kobe/settings/keybindings.yaml`.
 *
 * Why these matter: the resolver feeds REAL tmux bindings into every task
 * session: no-prefix root-table binds (`bind-key -n`) for navigation and
 * prefix-table binds (`bind-key`) for layout controls. A
 * translation bug here doesn't crash — it either installs a dead key
 * (chord → wrong tmux name) or, far worse, binds a bare letter that
 * shadows typing in the engine/shell panes. The root bare-key rejection,
 * prefix bare-key allowance, and chord→tmux-syntax mapping are the
 * load-bearing invariants.
 *
 * Only the pure half is tested; `resolveUserTmuxKeys` (file read +
 * Bun.YAML) is Bun-runtime-only and exercised by the smoke path.
 */

import { describe, expect, test } from "vitest"
import {
  TMUX_FOCUS_DEFAULTS,
  TMUX_FOCUS_ID,
  TMUX_LEGACY_LAYOUT_ROOT_KEYS,
  TMUX_PREFIX_BINDING_DEFAULTS,
  TMUX_SINGLE_BINDING_DEFAULTS,
  chordToTmuxKey,
  isTmuxPrefixBindingId,
  resolveTmuxKeyEntries,
} from "../../src/tmux/keybindings"

function keyOf(chord: string): string {
  const r = chordToTmuxKey(chord)
  if ("error" in r) throw new Error(`expected ${chord} to translate, got: ${r.error}`)
  return r.key
}

describe("chordToTmuxKey", () => {
  test("translates the shipped defaults to the exact keys ensureSession installed before", () => {
    expect(keyOf("ctrl+q")).toBe("C-q")
    expect(keyOf("ctrl+h")).toBe("C-h")
    expect(keyOf("ctrl+t")).toBe("C-t")
    expect(keyOf("ctrl+shift+t")).toBe("C-S-T")
    expect(keyOf("ctrl+[")).toBe("C-[")
    expect(keyOf("ctrl+]")).toBe("C-]")
    expect(keyOf("ctrl+w")).toBe("C-w")
    expect(keyOf("f2")).toBe("F2")
  })

  test("maps named keys to tmux spellings", () => {
    expect(keyOf("alt+pageup")).toBe("M-PgUp")
    expect(keyOf("ctrl+left")).toBe("C-Left")
    expect(keyOf("alt+enter")).toBe("M-Enter")
  })

  test("rejects cmd chords — the Command key never reaches tmux", () => {
    expect("error" in chordToTmuxKey("cmd+t")).toBe(true)
  })

  test("rejects bare keys that would shadow typing, but allows bare F-keys", () => {
    expect("error" in chordToTmuxKey("t")).toBe(true)
    expect("error" in chordToTmuxKey("escape")).toBe(true)
    expect(keyOf("f5")).toBe("F5")
  })

  test("allows bare keys for prefix-table bindings", () => {
    expect(chordToTmuxKey("s", { allowBare: true })).toEqual({ key: "s" })
    expect(chordToTmuxKey("escape", { allowBare: true })).toEqual({ key: "Escape" })
  })

  test("rejects key names tmux can't bind", () => {
    expect("error" in chordToTmuxKey("ctrl+banana")).toBe(true)
  })
})

describe("resolveTmuxKeyEntries", () => {
  test("no entries → the shipped defaults, nothing marked overridden", () => {
    const res = resolveTmuxKeyEntries([])
    expect(res.warnings).toEqual([])
    expect(res.overridden.size).toBe(0)
    expect(res.binds["tmux.tab.new"]).toEqual({ chord: "ctrl+t", key: "C-t" })
    expect(res.binds["tmux.layout.workspaceSplit"]).toEqual({ chord: "s", key: "s" })
    expect(res.binds["tmux.layout.terminalToggle"]).toEqual({ chord: "z", key: "z" })
    expect(res.focus.map((f) => f?.key)).toEqual(["C-h", "C-j", "C-k", "C-l"])
  })

  test("layout ids are prefix-table bindings and accept bare-key overrides", () => {
    expect(isTmuxPrefixBindingId("tmux.layout.workspaceSplit")).toBe(true)
    expect(TMUX_PREFIX_BINDING_DEFAULTS["tmux.layout.workspaceSplit"]).toBe("s")
    const res = resolveTmuxKeyEntries([{ id: "tmux.layout.workspaceSplit", keys: ["g"] }])
    expect(res.binds["tmux.layout.workspaceSplit"]).toEqual({ chord: "g", key: "g" })
    expect(res.overridden.has("tmux.layout.workspaceSplit")).toBe(true)
  })

  test("tracks the old F6-F11 root layout keys for stale tmux-server cleanup", () => {
    expect(TMUX_LEGACY_LAYOUT_ROOT_KEYS).toEqual(["F6", "F7", "F8", "F9", "F10", "F11"])
  })

  test("override + unbind: new key recorded, default key flagged for unbinding", () => {
    const res = resolveTmuxKeyEntries([
      { id: "tmux.tab.new", keys: ["ctrl+y"] },
      { id: "tmux.tab.close", keys: [] },
    ])
    expect(res.binds["tmux.tab.new"]).toEqual({ chord: "ctrl+y", key: "C-y" })
    expect(res.binds["tmux.tab.close"]).toBeNull()
    expect(res.overridden.has("tmux.tab.new")).toBe(true)
    expect(res.overridden.has("tmux.tab.close")).toBe(true)
    // Untouched ids keep defaults and are NOT marked overridden.
    expect(res.overridden.has("tmux.detach")).toBe(false)
  })

  test("tmux.focus is a positional 4-chord group (left/down/up/right)", () => {
    const res = resolveTmuxKeyEntries([
      { id: TMUX_FOCUS_ID, keys: ["ctrl+left", "ctrl+down", "ctrl+up", "ctrl+right"] },
    ])
    expect(res.focus.map((f) => f?.key)).toEqual(["C-Left", "C-Down", "C-Up", "C-Right"])
    expect(res.overridden.has(TMUX_FOCUS_ID)).toBe(true)
  })

  test("tmux.focus with the wrong count keeps the default and warns", () => {
    const res = resolveTmuxKeyEntries([{ id: TMUX_FOCUS_ID, keys: ["ctrl+left", "ctrl+right"] }])
    expect(res.focus.map((f) => f?.chord)).toEqual([...TMUX_FOCUS_DEFAULTS])
    expect(res.warnings.some((w) => w.includes("exactly 4"))).toBe(true)
    expect(res.overridden.has(TMUX_FOCUS_ID)).toBe(false)
  })

  test("untranslatable overrides keep the default and warn", () => {
    const res = resolveTmuxKeyEntries([{ id: "tmux.detach", keys: ["cmd+q"] }])
    expect(res.binds["tmux.detach"]).toEqual({ chord: TMUX_SINGLE_BINDING_DEFAULTS["tmux.detach"], key: "C-q" })
    expect(res.warnings.some((w) => w.includes("Command key"))).toBe(true)
    expect(res.overridden.has("tmux.detach")).toBe(false)
  })

  test("root-table ids still reject bare-key overrides", () => {
    const res = resolveTmuxKeyEntries([{ id: "tmux.tab.new", keys: ["n"] }])
    expect(res.binds["tmux.tab.new"]).toEqual({ chord: TMUX_SINGLE_BINDING_DEFAULTS["tmux.tab.new"], key: "C-t" })
    expect(res.warnings.some((w) => w.includes("bare key would shadow typing"))).toBe(true)
    expect(res.overridden.has("tmux.tab.new")).toBe(false)
  })

  test("unknown tmux ids warn; non-tmux ids are silently ignored (other layer)", () => {
    const res = resolveTmuxKeyEntries([
      { id: "tmux.nope", keys: ["ctrl+x"] },
      { id: "chat.fork.new", keys: ["ctrl+g"] },
    ])
    expect(res.warnings).toEqual(["tmux.nope: unknown tmux binding id"])
  })

  test("multi-chord entries use the first chord and warn", () => {
    const res = resolveTmuxKeyEntries([{ id: "tmux.tab.rename", keys: ["f6", "f7"] }])
    expect(res.binds["tmux.tab.rename"]).toEqual({ chord: "f6", key: "F6" })
    expect(res.warnings.some((w) => w.includes("ONE chord"))).toBe(true)
  })
})
