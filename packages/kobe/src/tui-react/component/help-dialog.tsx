/** @jsxImportSource @opentui/react */

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
  const close = () => (props.onClose ? props.onClose() : dialog.clear())

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
      {}
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

HelpDialog.show = (dialog: DialogContext): void => {
  dialog.replace(() => <HelpDialog />)
}
