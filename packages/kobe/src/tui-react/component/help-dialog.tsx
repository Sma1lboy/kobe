/** @jsxImportSource @opentui/react */
/**
 * Help dialog (React port of `src/tui/component/help-dialog.tsx`, issue
 * #15 G3) — kobe's global keybindings, grouped by category via the shared
 * framework-free `src/tui/lib/help-groups.ts`. Each row prints the
 * canonical chord (macOS glyphs via `formatChord`) plus the description;
 * alternate chords in a lighter color. Pane-local bindings are
 * intentionally not listed — this is the global-bindings registry only.
 * Full rationale (what was dropped in v0.6, why esc isn't re-bound here)
 * lives in the Solid header.
 *
 * React deltas: the keymap table is mutated in place on keybindings.yaml
 * reloads, invisible to React — `useKeymapVersion()` subscribes this
 * component and invalidates the grouped rows; `useT()` subscribes it to
 * language changes so the non-reactive `tKeys` lookups re-run.
 */

import { TextAttributes } from "@opentui/core"
import { useEffect, useMemo, useState } from "react"
import { runTmuxCapturing } from "../../tmux/client"
import { formatChord, tmuxPrefixGlyph } from "../../tui/lib/chord-glyphs"
import { groupBindings } from "../../tui/lib/help-groups"
import { KobeKeymap, useKeymapVersion } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { tKeys, useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

export function HelpDialog(props: { onClose?: () => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const keymapVersion = useKeymapVersion()
  // biome-ignore lint/correctness/useExhaustiveDependencies: keymapVersion is the invalidation key — the table is mutated in place.
  const grouped = useMemo(() => groupBindings(KobeKeymap), [keymapVersion])
  // Standalone full-window page (`kobe help-page`) passes its own exit;
  // the in-pane overlay closes by clearing the dialog stack.
  const close = () => (props.onClose ? props.onClose() : dialog.clear())

  // Resolve the user's real tmux prefix so `prefix f` shows as e.g. `⌃B F`
  // (their actual prefix, not a guess). Falls back to the `⌃B` default when
  // there's no kobe tmux server (e.g. the dev outer monitor).
  const [prefixGlyph, setPrefixGlyph] = useState("⌃B")
  useEffect(() => {
    let disposed = false
    void runTmuxCapturing(["show-options", "-g", "prefix"]).then(({ code, stdout }) => {
      if (disposed || code !== 0) return
      const glyph = tmuxPrefixGlyph(stdout)
      if (glyph) setPrefixGlyph(glyph)
    })
    return () => {
      disposed = true
    }
  }, [])

  // Press `?` again to dismiss (ergonomic mirror of vim/tmux help). esc
  // is handled by the DialogProvider's own binding stack — don't re-bind.
  useBindings(() => ({
    bindings: [{ key: "?", cmd: close }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexShrink={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("help.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={close}>
          {t("help.esc")}
        </text>
      </box>
      {/* Long-content dialogs handle their own overflow: flexShrink={1}
          fits the dialog's maxHeight, the scrollbox owns the scrolling. */}
      <scrollbox
        flexShrink={1}
        flexGrow={1}
        stickyScroll={false}
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: theme.backgroundDialog, foregroundColor: theme.borderActive },
        }}
      >
        <box paddingBottom={1} gap={1} paddingRight={1}>
          {grouped.map((group) => (
            <box key={group.category} gap={0}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                {tKeys("category", group.category)}
              </text>
              {group.rows.map((row) => {
                // Prefer hint.keys (the user-facing chord label, e.g. "j/k")
                // when present; fall back to the first registered chord.
                // Rendered as macOS key glyphs (⌃Q, ⇧⇥, ⌃B F) via formatChord
                // so the help matches the footer.
                const rawPrimary = row.hint?.keys ?? row.keys[0] ?? "—"
                const primary = rawPrimary === "—" ? "—" : formatChord(rawPrimary, prefixGlyph)
                const aliases = (row.hint ? row.keys : row.keys.slice(1)).map((k) => formatChord(k, prefixGlyph))
                return (
                  <box key={row.id} flexDirection="row" gap={2} paddingLeft={1}>
                    <box width={14}>
                      <text fg={theme.primary}>{primary}</text>
                    </box>
                    <box flexGrow={1}>
                      <text fg={theme.text}>{tKeys("desc", row.id)}</text>
                    </box>
                    {aliases.length > 0 ? (
                      <box>
                        <text fg={theme.textMuted}>{`(${aliases.join(", ")})`}</text>
                      </box>
                    ) : null}
                  </box>
                )
              })}
            </box>
          ))}
        </box>
      </scrollbox>
    </box>
  )
}

/**
 * Convenience opener — pushes the help dialog onto the dialog stack.
 * Used by the global `?` binding. Static for parity with the Solid original.
 */
HelpDialog.show = (dialog: DialogContext): void => {
  dialog.replace(() => <HelpDialog />)
}
