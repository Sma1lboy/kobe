/**
 * Release / update dialog — shown when the user clicks the version or
 * update chip in the TopBar.
 *
 * Renders three sections:
 *   1. Header with current / latest version state.
 *   2. Optional update action and command when npm reports an update.
 *   3. Recent version chips so up-to-date users can still inspect
 *      previous changelogs from the same surface.
 *   4. "What's new" — the GitHub release body for the selected tag,
 *      rendered through kobe's Markdown component.
 *
 * Closing: `esc` is handled by the DialogProvider's binding stack
 * (same pattern as HelpDialog). Clicking the `esc` chip in the corner
 * also dismisses.
 */

import { TextAttributes } from "@opentui/core"
import { For, type JSXElement, Match, Show, Switch, createMemo, createResource, createSignal } from "solid-js"
import {
  type ReleaseNotes,
  UPDATE_COMMAND,
  type UpdateInfo,
  fetchReleaseNotes,
  fetchReleaseSummaries,
  recommendedGlobalInstallCommand,
  releasePageUrl,
} from "../../version.ts"
import { useTheme } from "../context/theme"
import { Markdown } from "../panes/chat/Markdown"
import { type DialogContext, useDialog } from "../ui/dialog"
import { defaultReleaseDialogVersion, releaseDialogTitle, releaseDialogVersionChoices } from "./update-dialog-helpers"

export type UpdateDialogProps = {
  info: UpdateInfo
  onUpdate?: () => void
}

export function UpdateDialog(props: UpdateDialogProps): JSXElement {
  const dialog = useDialog()
  const { theme } = useTheme()

  const [selectedVersion, setSelectedVersion] = createSignal(defaultReleaseDialogVersion(props.info))
  const [releaseSummaries] = createResource(() => fetchReleaseSummaries())
  const versionChoices = createMemo(() => releaseDialogVersionChoices(props.info, releaseSummaries() ?? []))

  // Fetch release notes for the selected version. Resource state:
  //   - undefined while loading
  //   - null when the fetch failed (offline / 404 / etc.)
  //   - ReleaseNotes on success
  const [notes] = createResource<ReleaseNotes | null, string>(selectedVersion, fetchReleaseNotes)

  const fallbackUrl = () => releasePageUrl(selectedVersion())

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      {/* Title row + esc dismiss. */}
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {releaseDialogTitle(props.info)}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      {/* Version state. */}
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>v{props.info.current}</text>
        <Show
          when={props.info.hasUpdate}
          fallback={
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              up to date
            </text>
          }
        >
          <text fg={theme.textMuted}>→</text>
          <text fg={theme.warning} attributes={TextAttributes.BOLD}>
            v{props.info.latest}
          </text>
        </Show>
      </box>

      <Show when={props.info.hasUpdate}>
        {/* Update action + command. The button delegates to TopBar so the
            renderer teardown and process exit stay in one place. */}
        <box gap={0}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.warning} attributes={TextAttributes.BOLD} onMouseUp={props.onUpdate}>
              [Update]
            </text>
            <text fg={theme.textMuted}>or run:</text>
          </box>
          <box paddingLeft={2}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              {UPDATE_COMMAND}
            </text>
          </box>
          <box paddingLeft={2}>
            <text fg={theme.textMuted}>Manual fallback: {recommendedGlobalInstallCommand()}</text>
          </box>
        </box>
      </Show>

      <box gap={0}>
        <text fg={theme.textMuted}>Versions:</text>
        <box flexDirection="row" gap={1} paddingLeft={2}>
          <For each={versionChoices()}>
            {(version) => {
              const selected = () => version === selectedVersion()
              return (
                <text
                  fg={selected() ? theme.accent : theme.textMuted}
                  attributes={selected() ? TextAttributes.BOLD : undefined}
                  onMouseUp={() => setSelectedVersion(version)}
                >
                  v{version}
                </text>
              )
            }}
          </For>
        </box>
      </box>

      {/* What's new — GitHub release body, falling back through resource
          states so the dialog never just "hangs" looking empty. */}
      <box gap={0}>
        <text fg={theme.textMuted}>What's new in v{selectedVersion()}:</text>
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
UpdateDialog.show = (dialog: DialogContext, info: UpdateInfo, onUpdate?: () => void): void => {
  dialog.replace(() => <UpdateDialog info={info} onUpdate={onUpdate} />)
}
