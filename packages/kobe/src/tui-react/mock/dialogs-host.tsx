/** @jsxImportSource @opentui/react */
/**
 * React dialogs/notifications mock host (`bun run dev:mock-react-dialogs`,
 * issue #15 G3) — the live render proof for the small-shared-dialogs slice:
 * NotificationsProvider wired through `bootPaneHost` (providers:
 * notifications), VersionSkewBanner, ToastOverlay, and HelpDialog all on
 * one screen.
 *
 * At boot the banner is visible (stale=true) and a fixture toast fires;
 * ~2.5s in, the help dialog opens on its own so a piped `timeout 6` run
 * captures every fixture string without keystroke injection. Interactive
 * keys: `?` help dialog · n toast · e error toast · v toggle banner ·
 * q / ctrl+c quit.
 */

import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useState } from "react"
import { HelpDialog } from "../component/help-dialog"
import { ToastOverlay } from "../component/toast-overlay"
import { VersionSkewBanner } from "../component/version-skew-banner"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"

/** Render-proof grep string for the dev:mock-react-dialogs gate. */
const MOCK_TOAST_TITLE = "React toast fixture"

function MockDialogsScreen() {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const notif = useNotifications()
  const dialog = useDialog()
  const [stale, setStale] = useState(true)

  // Boot sequence for the piped proof: fixture toast immediately, help
  // dialog after the first frames so the banner/toast strings are captured
  // before the dialog backdrop covers them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: boot-once sequence.
  useEffect(() => {
    notif.notify({ kind: "done", taskId: "mock-task", tabId: "tab-1", title: MOCK_TOAST_TITLE })
    const timer = setTimeout(() => HelpDialog.show(dialog), 2500)
    return () => clearTimeout(timer)
  }, [])

  useBindings(() => ({
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
      { key: "?", cmd: () => HelpDialog.show(dialog) },
      {
        key: "n",
        cmd: () => notif.notify({ kind: "done", taskId: "mock-task", tabId: "tab-1", title: MOCK_TOAST_TITLE }),
      },
      {
        key: "e",
        cmd: () => notif.notify({ kind: "error", taskId: "mock-task", tabId: "tab-2", title: "mock error toast" }),
      },
      { key: "v", cmd: () => setStale((s) => !s) },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <VersionSkewBanner stale={stale} daemonVersion="0.0.1" clientVersion="0.0.2" width={dims.width} />
      <box paddingLeft={1} paddingRight={1} flexDirection="column" flexGrow={1}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          REACT dialogs workbench
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          ? help · n toast · e error toast · v banner · q quit — unread: {notif.unread.size}
        </text>
      </box>
      <ToastOverlay />
    </box>
  )
}

await bootPaneHost({
  logContext: "mock-dialogs",
  providers: { notifications: true },
  setup: () => ({ root: () => <MockDialogsScreen /> }),
})
