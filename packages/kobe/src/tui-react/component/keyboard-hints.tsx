/** @jsxImportSource @opentui/react */
/**
 * Keyboard-discoverability hints — the React half of
 * `src/tui/lib/keyboard-hints.ts`:
 *
 *   - `StatusKeyHintBar` / `useStatusKeyHintItems`: the permanent status-bar
 *     micro-hint (`⌃ A commands · F1 help · [settings]`), terminal-
 *     passthrough aware. Every segment is mouse-activatable (clicks don't
 *     pass through to the PTY, so the [settings] button works even inside
 *     the terminal, where the keyboard path is longest).
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

import { useCallback, useEffect, useState } from "react"
import { formatChord } from "../../tui/lib/chord-glyphs"
import {
  type HintPane,
  KEY_HINTS_ENABLED_KEY,
  PANE_HINT_USED_KEYS,
  type StatusHintToken,
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
import {
  armPrefixFromCurrentStack,
  currentBindingReachability,
  modalActive,
  useBindingStackVersion,
} from "../lib/keymap"
import { useOptionalDialog } from "../ui/dialog"
import { HelpDialog } from "./help-dialog"

export type StatusKeyHintItem = {
  text: string
  /** Mouse activation — the same action the advertised key would run. */
  onPress?: () => void
}

/**
 * The status-bar hint segments, empty when there is nothing truthful to say
 * (hints toggled off, prefix disabled AND help unbound, …). Reads the live
 * binding stack, so an open modal or a context with no reachable prefix
 * commands reshapes it automatically.
 */
export function useStatusKeyHintItems(opts?: { onOpenSettings?: () => void; compact?: boolean }): StatusKeyHintItem[] {
  const t = useT()
  const kv = useOptionalKV()
  // Reachability is a function of the focused pane, the live keymap, and
  // which bindings are registered (registration happens in mount effects,
  // AFTER the first render) — subscribe to all three so a change in any of
  // them re-renders this consumer and re-runs the effect below.
  const focus = useOptionalFocus()
  const dialog = useOptionalDialog()
  useKeymapVersion()
  useBindingStackVersion()
  const [snapshot, setSnapshot] = useState<{ tokens: readonly StatusHintToken[]; modal: boolean }>({
    tokens: [],
    modal: false,
  })
  // Snapshot AFTER every commit, never during render: `enabled` gates like
  // the terminal passthrough table read render-refreshed refs in CHILD
  // components, and this hook renders in a parent (the workspace footer) —
  // a render-time read sees the PREVIOUS cycle's focus and command set.
  // Effects run children-first, so by the time this one
  // fires the whole tree's refs and registrations are current. The
  // compare-and-set keeps the no-change case from looping.
  useEffect(() => {
    const enabled = keyHintsEnabled(kv?.get(KEY_HINTS_ENABLED_KEY, true))
    // Two independent signals, both meaning "an overlay owns input": the
    // registered modal barrier, and a non-empty dialog stack. The stack
    // fills a render EARLIER (the workspace bindings gate themselves off
    // it), so checking only the barrier catches one frame where
    // reachability is already empty but nothing looks modal yet — and the
    // footer blanks out for good.
    const nextModal = modalActive() || (dialog?.stack.length ?? 0) > 0
    const fresh =
      enabled && !nextModal ? statusHintTokens(currentBindingReachability(), currentPrefixConfiguration().key) : null
    setSnapshot((prev) => {
      // A modal barrier cuts the reachability walk short, so recomputing
      // under one yields an empty set and the footer row would vanish the
      // moment F1/any dialog opens. Freeze the last non-modal tokens
      // instead — the row stays put as a visual anchor; its segments go
      // inert below, so nothing advertised there fires under the dialog.
      const nextTokens = fresh ?? (enabled ? prev.tokens : [])
      return prev.modal === nextModal &&
        prev.tokens.length === nextTokens.length &&
        prev.tokens.every((tok, i) => tok.chord === nextTokens[i]?.chord && tok.msg === nextTokens[i]?.msg)
        ? prev
        : { tokens: nextTokens, modal: nextModal }
    })
  })
  // Click = the action the advertised key would run. Arming the prefix goes
  // through the REAL dispatcher state, so the which-key guide that appears
  // accepts a keyboard second stroke exactly like a pressed ctrl+a.
  // Inert under a modal: the row stays legible, but clicking a segment must
  // not arm the prefix / open a second dialog under the open one.
  const actions: Record<StatusHintToken["msg"], (() => void) | undefined> = snapshot.modal
    ? { commands: undefined, sidebar: undefined, help: undefined }
    : {
        commands: () => void armPrefixFromCurrentStack(),
        sidebar: focus ? () => focus.setFocused("sidebar") : undefined,
        help: dialog ? () => HelpDialog.show(dialog, focus?.focused ?? "sidebar") : undefined,
      }
  // Compact (narrow footer, issue #14): the chord caps alone — `⌃ A · F1` —
  // still clickable, no verbs, and no [settings] segment below.
  const items: StatusKeyHintItem[] = snapshot.tokens.map((tok) => ({
    text: opts?.compact ? formatChord(tok.chord) : t(`hints.status.${tok.msg}`, { key: formatChord(tok.chord) }),
    onPress: actions[tok.msg],
  }))
  // Bracketed like the other clickable chips ([~] Zen, [enter] Send) — and
  // deliberately NO glyph: U+2699 ⚙ is East-Asian-Ambiguous width, so
  // terminals disagree on whether it takes 1 or 2 cells and the row
  // misaligns per OS/font. Stays on screen while a modal owns input, but
  // inert — Settings must not open under a dialog.
  if (opts?.onOpenSettings && !opts.compact && keyHintsEnabled(kv?.get(KEY_HINTS_ENABLED_KEY, true))) {
    items.push({
      text: `[${t("hints.status.settings")}]`,
      onPress: snapshot.modal ? undefined : opts.onOpenSettings,
    })
  }
  return items
}

/** The footer's hint row: muted key captions, each mouse-activatable. */
export function StatusKeyHintBar(props: { onOpenSettings?: () => void; compact?: boolean }) {
  const { theme } = useTheme()
  const items = useStatusKeyHintItems({ onOpenSettings: props.onOpenSettings, compact: props.compact })
  if (items.length === 0) return null
  return (
    <box flexDirection="row" flexShrink={0}>
      {items.flatMap((item, index) => [
        index > 0 ? (
          <text key={`sep-${item.text}`} fg={theme.textMuted} wrapMode="none">
            {" · "}
          </text>
        ) : null,
        <box key={item.text} onMouseUp={item.onPress}>
          <text fg={theme.textMuted} wrapMode="none">
            {item.text}
          </text>
        </box>,
      ])}
    </box>
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
