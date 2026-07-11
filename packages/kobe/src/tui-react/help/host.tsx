/** @jsxImportSource @opentui/react */
/**
 * `kobe help-page` — React host (issue #15, G3), the `src/tui/help/host.tsx`
 * counterpart. React is the default runtime since 2026-07-07 (`uiFramework()`
 * in `src/env.ts`); `KOBE_SOLID=1` is the legacy escape hatch. Same contract:
 * the F1 keybindings
 * help as a standalone full-window surface, rendering the SAME `HelpDialog`
 * component the in-pane overlay pushes onto the dialog stack; closing
 * (q / esc / F1 / ? / Ctrl+C) exits the process so tmux closes the window.
 * Purely read-only — no daemon connection, no KV/Focus providers.
 */

import { HelpDialog } from "../component/help-dialog"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { pageCloseBindings, useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"

function HelpPage() {
  const dialog = useDialog()
  const { theme } = useTheme()

  function exit(): void {
    process.exit(0)
  }

  // Page-level close keys. In the overlay surface the dialog stack owns
  // esc/Ctrl+C; here there's no enclosing stack, so the page binds them
  // itself — plus `q` (the page is not a text input) and `f1` so the
  // opening chord also toggles the page closed. `?` is bound inside
  // HelpDialog via its onClose prop.
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [...pageCloseBindings(exit), { key: "f1", cmd: exit }],
  }))

  return (
    // The component sizes itself with an internal scrollbox; give it the
    // full window height so tall keymaps scroll instead of clipping.
    <box flexGrow={1} backgroundColor={theme.background} paddingTop={1}>
      <HelpDialog onClose={exit} />
    </box>
  )
}

export async function startHelpHost(): Promise<void> {
  await bootPaneHost({
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <HelpPage /> }),
  })
}
