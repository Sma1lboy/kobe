/**
 * `kobe help-page` — the F1 keybindings help rendered as a standalone
 * full-window surface, mirroring `kobe settings` (settings/host.tsx).
 *
 * This is the SAME `HelpDialog` component the in-pane overlay pushes onto
 * the dialog stack — reused verbatim — only here it fills its own tmux
 * window instead of squeezing into the narrow Tasks rail. Opened by
 * `openHelpTab`, which spawns this as a new window via `kobe help-page`;
 * closing it (q / esc / F1 / ? / Ctrl+C) exits the process, so tmux
 * closes the window and returns to the previous tab.
 *
 * Purely read-only (it renders the static `KobeKeymap` table), so it
 * needs no daemon connection and no KV/Focus providers.
 */

import { HelpDialog } from "../component/help-dialog"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
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
    bindings: [
      { key: "escape", cmd: exit },
      { key: "q", cmd: exit },
      { key: "f1", cmd: exit },
      { key: "ctrl+c", cmd: exit },
    ],
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
