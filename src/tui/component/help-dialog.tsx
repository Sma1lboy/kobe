/**
 * Help dialog — shows kobe's current global keybindings.
 *
 * Reads the static `KobeKeymap` table from `context/keybindings.ts`. Groups
 * by `category`. Each row prints the canonical chord (the first entry of
 * `binding.keys`) plus the description; alternate chords are listed in a
 * lighter color so users learn the bindings without losing the option to
 * see what else triggers it.
 *
 * Pane-local bindings are intentionally not listed here — they live in the
 * pane that registers them and are surfaced by that pane's own help if it
 * has one. This dialog is the global-bindings registry, no more.
 *
 * Closing: `esc` is handled by the DialogProvider stack (it's already
 * registered higher on the binding stack than this component's bindings,
 * so we don't need to re-register it). We DO register `?` so users can
 * tap `?` again to dismiss while the help dialog is on top — a small
 * ergonomic win that mirrors how vim and tmux behave. (Bare `?` is no
 * longer a global open chord; F1 is. The dismiss-only binding is safe
 * here because the help dialog has no input fields to collide with.)
 */

import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { type KobeBinding, KobeKeymap } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

/** Sentinel string the behavior test asserts on. */
export const HELP_DIALOG_TITLE = "kobe — keybindings"

/**
 * Group the flat keymap into categories in declaration order.
 */
function groupBindings(keymap: readonly KobeBinding[]): { category: string; rows: readonly KobeBinding[] }[] {
  const groups = new Map<string, KobeBinding[]>()
  const order: string[] = []
  for (const b of keymap) {
    if (!groups.has(b.category)) {
      groups.set(b.category, [])
      order.push(b.category)
    }
    groups.get(b.category)!.push(b)
  }
  return order.map((cat) => ({ category: cat, rows: groups.get(cat)! }))
}

export function HelpDialog() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const grouped = () => groupBindings(KobeKeymap)

  // Press `?` again to dismiss (ergonomic mirror of vim/tmux help). esc
  // is handled by the DialogProvider's own binding stack — don't re-bind.
  useBindings(() => ({
    bindings: [
      {
        key: "?",
        cmd: () => dialog.clear(),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {HELP_DIALOG_TITLE}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingBottom={1} gap={1}>
        <For each={grouped()}>
          {(group) => (
            <box gap={0}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                {group.category}
              </text>
              <For each={group.rows}>
                {(row) => {
                  const primary = row.keys[0] ?? ""
                  const aliases = row.keys.slice(1)
                  return (
                    <box flexDirection="row" gap={2} paddingLeft={1}>
                      <box width={14}>
                        <text fg={theme.primary}>{primary}</text>
                      </box>
                      <box flexGrow={1}>
                        <text fg={theme.text}>{row.description}</text>
                      </box>
                      {aliases.length > 0 ? (
                        <box>
                          <text fg={theme.textMuted}>{`(${aliases.join(", ")})`}</text>
                        </box>
                      ) : null}
                    </box>
                  )
                }}
              </For>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

/**
 * Convenience opener — pushes the help dialog onto the dialog stack.
 * Used by the global `?` binding. Static for parity with `DialogConfirm.show`.
 */
HelpDialog.show = (dialog: DialogContext): void => {
  dialog.replace(() => <HelpDialog />)
}
