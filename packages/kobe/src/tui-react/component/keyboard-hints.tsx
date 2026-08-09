/** @jsxImportSource @opentui/react */
/**
 * Keyboard-discoverability hints — the React half of
 * `src/tui/lib/keyboard-hints.ts`:
 *
 *   - `StatusKeyHint` / `useStatusKeyHintText`: the permanent status-bar
 *     micro-hint (`⌃ A commands · F1 help`), terminal-passthrough aware.
 *   - `PaneKeyHint`: one muted line per vim-style pane (sidebar/files);
 *     the fuller first-use variant extinguishes permanently once the pane's
 *     own keys are used (`usePaneHintMark`).
 *
 * Both are plain muted text on the ambient background — deliberately no
 * backgroundColor of their own, so they stay readable over normal AND
 * transparent themes (pinned by test/tui-react/keyboard-overlay-theme.test).
 * Every chord resolves through the live keymap; `useKeymapVersion()` keeps
 * an on-screen hint truthful across live YAML rebinds.
 */

import { useCallback } from "react"
import { formatChord } from "../../tui/lib/chord-glyphs"
import {
  type HintPane,
  KEY_HINTS_ENABLED_KEY,
  PANE_HINT_USED_KEYS,
  keyHintsEnabled,
  paneHintTokens,
  paneHintVisible,
  statusHintTokens,
} from "../../tui/lib/keyboard-hints"
import { currentPrefixConfiguration } from "../../tui/lib/keymap-dispatch"
import { useOptionalFocus } from "../context/focus"
import { useKeymapVersion } from "../context/keybindings"
import { useOptionalKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { currentBindingReachability, useBindingStackVersion } from "../lib/keymap"

/**
 * The status-bar hint line, or null when it has nothing truthful to say
 * (hints toggled off, prefix disabled AND help unbound, …). Reads the live
 * binding stack, so an open modal or the terminal passthrough boundary
 * reshapes it automatically.
 */
export function useStatusKeyHintText(): string | null {
  const t = useT()
  const kv = useOptionalKV()
  // Reachability is a function of the focused pane, the live keymap, and
  // which bindings are registered (registration happens in mount effects,
  // AFTER the first render) — subscribe to all three so the snapshot below
  // is recomputed when any of them changes.
  useOptionalFocus()
  useKeymapVersion()
  useBindingStackVersion()
  if (!keyHintsEnabled(kv?.get(KEY_HINTS_ENABLED_KEY, true))) return null
  const tokens = statusHintTokens(currentBindingReachability(), currentPrefixConfiguration().key)
  if (tokens.length === 0) return null
  return tokens.map((tok) => t(`hints.status.${tok.msg}`, { key: formatChord(tok.chord) })).join(" · ")
}

/** Thin renderable wrapper over {@link useStatusKeyHintText}. */
export function StatusKeyHint() {
  const { theme } = useTheme()
  const text = useStatusKeyHintText()
  if (text === null) return null
  return (
    <text fg={theme.textMuted} wrapMode="none">
      {text}
    </text>
  )
}

/**
 * Extinguish a pane's first-use hint: call from the pane's own key handlers
 * (nav/select) — using the keys IS the proof the hint is no longer needed.
 * Writes once; safe to call per keypress.
 */
export function usePaneHintMark(pane: HintPane): () => void {
  const kv = useOptionalKV()
  return useCallback(() => {
    if (!kv) return
    if (kv.get(PANE_HINT_USED_KEYS[pane], false) !== true) kv.set(PANE_HINT_USED_KEYS[pane], true)
  }, [kv, pane])
}

/**
 * A pane's hint line: the fuller first-use variant until the pane's keys
 * have been used, then the pane's permanent short set (empty for the
 * sidebar — it renders nothing after first use). Null when hints are off
 * or every advertised binding is unbound.
 */
export function PaneKeyHint(props: { pane: HintPane }) {
  const t = useT()
  const { theme } = useTheme()
  const kv = useOptionalKV()
  useKeymapVersion()
  const enabledRaw = kv?.get(KEY_HINTS_ENABLED_KEY, true)
  const usedRaw = kv?.get(PANE_HINT_USED_KEYS[props.pane], false)
  if (!keyHintsEnabled(enabledRaw)) return null
  const tokens = paneHintTokens(props.pane, paneHintVisible(enabledRaw, usedRaw) ? "firstUse" : "always")
  if (tokens.length === 0) return null
  return (
    <text fg={theme.textMuted} wrapMode="none">
      {tokens.map((tok) => `${formatChord(tok.cap)} ${t(`hints.pane.${tok.msg}`)}`).join(" · ")}
    </text>
  )
}
