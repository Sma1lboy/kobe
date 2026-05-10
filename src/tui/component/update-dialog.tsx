/**
 * Update-available dialog — shown when the user clicks the
 * `↑ vX.Y.Z available` chip in the TopBar.
 *
 * Renders three sections:
 *   1. Header with current → latest version arrow.
 *   2. Install command (one-liner; user copies it themselves —
 *      no auto-update per the original "暂时不提供更新api" decision).
 *   3. "What's new" — the GitHub release body for the latest tag,
 *      rendered through kobe's Markdown component so it looks like
 *      the chat does. Falls back to a "see release notes" link when
 *      the GitHub API is unreachable.
 *
 * Closing: `esc` is handled by the DialogProvider's binding stack
 * (same pattern as HelpDialog). Clicking the `esc` chip in the corner
 * also dismisses.
 */

import { TextAttributes } from "@opentui/core"
import { type JSXElement, Match, Show, Switch, createResource } from "solid-js"
import {
  INSTALL_COMMAND,
  type ReleaseNotes,
  type UpdateInfo,
  fetchReleaseNotes,
  releasePageUrl,
} from "../../version.ts"
import { useTheme } from "../context/theme"
import { Markdown } from "../panes/chat/Markdown"
import { type DialogContext, useDialog } from "../ui/dialog"

export type UpdateDialogProps = {
  info: UpdateInfo
}

export function UpdateDialog(props: UpdateDialogProps): JSXElement {
  const dialog = useDialog()
  const { theme } = useTheme()

  // Fetch release notes for the *latest* version (what the user
  // would get after running the install command). Resource state:
  //   - undefined while loading
  //   - null when the fetch failed (offline / 404 / etc.)
  //   - ReleaseNotes on success
  const [notes] = createResource<ReleaseNotes | null>(() => fetchReleaseNotes(props.info.latest))

  const fallbackUrl = () => releasePageUrl(props.info.latest)

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      {/* Title row + esc dismiss. */}
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Update available
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      {/* Version transition. */}
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>v{props.info.current}</text>
        <text fg={theme.textMuted}>→</text>
        <text fg={theme.warning} attributes={TextAttributes.BOLD}>
          v{props.info.latest}
        </text>
      </box>

      {/* Install command — rendered as a "code block" with a copy hint.
          We don't auto-copy because OSC52 isn't available everywhere,
          and the visible string is short enough to select with the
          terminal's own selection. */}
      <box gap={0}>
        <text fg={theme.textMuted}>Run this to update:</text>
        <box paddingLeft={2}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            {INSTALL_COMMAND}
          </text>
        </box>
      </box>

      {/* What's new — GitHub release body, falling back through resource
          states so the dialog never just "hangs" looking empty. */}
      <box gap={0}>
        <text fg={theme.textMuted}>What's new:</text>
        <box paddingLeft={2} paddingTop={1}>
          <Switch>
            <Match when={notes.loading}>
              <text fg={theme.textMuted}>Loading release notes…</text>
            </Match>
            <Match when={notes() === null}>
              <box gap={0}>
                <text fg={theme.textMuted}>(couldn't reach GitHub — see the release page directly)</text>
                <Show when={fallbackUrl()}>
                  <text fg={theme.accent}>{fallbackUrl()}</text>
                </Show>
              </box>
            </Match>
            <Match when={notes()}>
              <box flexDirection="column" gap={0}>
                <Markdown source={notes()?.body ?? ""} />
                <Show when={notes()?.url}>
                  <box paddingTop={1}>
                    <text fg={theme.textMuted}>Full release: {notes()?.url}</text>
                  </box>
                </Show>
              </box>
            </Match>
          </Switch>
        </box>
      </box>
    </box>
  )
}

/**
 * Convenience opener — pushes the dialog onto the dialog stack.
 * Mirrors `HelpDialog.show()` / `DialogConfirm.show()`.
 */
UpdateDialog.show = (dialog: DialogContext, info: UpdateInfo): void => {
  dialog.replace(() => <UpdateDialog info={info} />)
}
