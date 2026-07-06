/** @jsxImportSource @opentui/react */
/**
 * React pilot entry (issue #15) — G1 established the isolated runtime;
 * G2 upgraded this host to mount the full React infrastructure stack
 * (Theme → Focus → Dialog providers + useBindings + i18n) so `bun run
 * dev:mock-react` is an end-to-end proof that the ported context layer
 * renders and dispatches keys. Deliberately NOT wired into the CLI entry
 * or compile graph yet.
 *
 * Keys: q quits · tab cycles pane focus · d opens a dialog (esc closes).
 */

import { TextAttributes, createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { FocusProvider, PANE_ORDER, useFocus } from "../context/focus"
import { ThemeProvider, useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import { Dialog, DialogProvider, useDialog } from "../ui/dialog"

function DemoDialog() {
  const { theme } = useTheme()
  const dialog = useDialog()
  return (
    <Dialog size="small" onClose={() => dialog.clear()}>
      <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.text} wrapMode="word">
          React dialog stack works — esc closes.
        </text>
      </box>
    </Dialog>
  )
}

function Workbench() {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const focus = useFocus()
  const dialog = useDialog()

  useBindings(() => ({
    enabled: true,
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "tab", cmd: () => focus.cycle(1) },
      { key: "d", cmd: () => dialog.replace(() => <DemoDialog />) },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box
        flexDirection="row"
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          REACT
        </text>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          kobe infra pilot
        </text>
        <box flexGrow={1} />
        <text fg={theme.textMuted} wrapMode="none">
          q quit · tab focus · d dialog
        </text>
      </box>
      <box paddingLeft={1} paddingRight={1} paddingTop={1} flexDirection="column" flexGrow={1}>
        <text fg={theme.text} wrapMode="word">
          {/* i18n runtime proof: a real catalog key through the shared lookup. */}
          {t("chat.thinking")} — theme "{themeCtx.selected}", focused pane: {focus.focused}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          panes: {PANE_ORDER.map((p) => (p === focus.focused ? `[${p}]` : p)).join(" ")}
        </text>
      </box>
    </box>
  )
}

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(
  <ThemeProvider>
    <FocusProvider>
      <DialogProvider>
        <Workbench />
      </DialogProvider>
    </FocusProvider>
  </ThemeProvider>,
)
