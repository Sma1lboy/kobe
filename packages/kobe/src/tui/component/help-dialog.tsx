/**
 * Help dialog — shows kobe's current global keybindings and the bundled
 * slash commands the composer recognises.
 *
 * Reads the static `KobeKeymap` table from `context/keybindings.ts`. Groups
 * by `category`. Each row prints the canonical chord (the first entry of
 * `binding.keys`) plus the description; alternate chords are listed in a
 * lighter color so users learn the bindings without losing the option to
 * see what else triggers it.
 *
 * After the keybinding list comes a "Slash commands" section sourced from
 * `BUILTIN_CLAUDE_SLASHES` — the static manifest of slashes that ship with
 * claude-code. User-defined slashes (project + `~/.claude/{commands,skills}/`)
 * are NOT listed here on purpose: they are async + worktree-scoped, and
 * the dialog provider has no worktree handle. The composer's `/` dropdown
 * is still the canonical place to discover and tab-complete every slash —
 * the dialog footer hint nudges users there.
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
import { For, createSignal, onMount } from "solid-js"
import { runTmuxCapturing } from "../../tmux/client"
import { type KobeBinding, KobeKeymap } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { formatChord, tmuxPrefixGlyph } from "../lib/chord-glyphs"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

// v0.6 dropped the chat composer, so the "Slash commands" section
// (which read `BUILTIN_CLAUDE_SLASHES` from the composer) is gone.
// Users discover slashes natively inside the interactive `claude`
// pane now. The dialog stays focused on kobe's own keybindings.

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

export function HelpDialog(props: { onClose?: () => void } = {}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const grouped = () => groupBindings(KobeKeymap)
  // Standalone full-window page (`kobe help-page`) passes its own exit;
  // the in-pane overlay closes by clearing the dialog stack.
  const close = () => (props.onClose ? props.onClose() : dialog.clear())

  // Resolve the user's real tmux prefix so `prefix f` shows as e.g. `⌃B F`
  // (their actual prefix, not a guess). Falls back to the `⌃B` default when
  // there's no kobe tmux server (e.g. the dev outer monitor).
  const [prefixGlyph, setPrefixGlyph] = createSignal("⌃B")
  onMount(() => {
    void runTmuxCapturing(["show-options", "-g", "prefix"]).then(({ code, stdout }) => {
      if (code !== 0) return
      const glyph = tmuxPrefixGlyph(stdout)
      if (glyph) setPrefixGlyph(glyph)
    })
  })

  // Press `?` again to dismiss (ergonomic mirror of vim/tmux help). esc
  // is handled by the DialogProvider's own binding stack — don't re-bind.
  useBindings(() => ({
    bindings: [
      {
        key: "?",
        cmd: close,
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexShrink={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {HELP_DIALOG_TITLE}
        </text>
        <text fg={theme.textMuted} onMouseUp={close}>
          esc
        </text>
      </box>
      {/* Scroll the help body. The dialog wrapper no longer wraps every
          modal in a scrollbox (it stretched short cards); long-content
          dialogs handle their own overflow. flexShrink={1} lets this
          shrink to fit the dialog's maxHeight, and the scrollbox
          handles overflow with mouse wheel + arrow keys. */}
      <scrollbox
        flexShrink={1}
        flexGrow={1}
        stickyScroll={false}
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: theme.backgroundDialog, foregroundColor: theme.borderActive },
        }}
      >
        <box paddingBottom={1} gap={1} paddingRight={1}>
          <For each={grouped()}>
            {(group) => (
              <box gap={0}>
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  {group.category}
                </text>
                <For each={group.rows}>
                  {(row) => {
                    // Prefer hint.keys (the user-facing chord label, e.g.
                    // "j/k" or "enter") when present; fall back to the
                    // first registered chord. Bindings with no chord and
                    // no hint (shouldn't happen in practice) show "—".
                    // Rendered as macOS key glyphs (⌃Q, ⇧⇥, ⌃B F) via
                    // formatChord so the help matches the footer.
                    const rawPrimary = row.hint?.keys ?? row.keys[0] ?? "—"
                    const primary = () => (rawPrimary === "—" ? "—" : formatChord(rawPrimary, prefixGlyph()))
                    const aliases = () =>
                      (row.hint ? row.keys : row.keys.slice(1)).map((k) => formatChord(k, prefixGlyph()))
                    return (
                      <box flexDirection="row" gap={2} paddingLeft={1}>
                        <box width={14}>
                          <text fg={theme.primary}>{primary()}</text>
                        </box>
                        <box flexGrow={1}>
                          <text fg={theme.text}>{row.description}</text>
                        </box>
                        {aliases().length > 0 ? (
                          <box>
                            <text fg={theme.textMuted}>{`(${aliases().join(", ")})`}</text>
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
      </scrollbox>
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
