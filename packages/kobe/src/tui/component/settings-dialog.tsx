/**
 * Settings dialog (v0.6).
 *
 * v0.5 had model picker, account info, and engine-vendor preferences
 * in here — all gone with the chat surface. v0.6 keeps the user-
 * controllable settings that still apply:
 *
 *   - Theme (cycle through installed themes)
 *   - Transparent background (toggle)
 *   - Saved repos (read-only list with a hint to `kobe add` more)
 *
 * Tab cycles sections, ←/→ cycles values inside the active section,
 * enter closes. Esc cancels via the dialog stack.
 */

import { TextAttributes } from "@opentui/core"
import { For, Show, createSignal } from "solid-js"
import { getSavedRepos } from "../../state/repos"
import { listThemes, useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

type Section = "theme" | "transparent" | "repos"
const SECTION_ORDER: readonly Section[] = ["theme", "transparent", "repos"]

export function SettingsDialogView(props: { onClose: () => void }) {
  const dialog = useDialog()
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const [section, setSection] = createSignal<Section>("theme")
  const themes = listThemes()
  const repos = getSavedRepos()
  // We mirror the current selection rather than reading themeCtx.selected
  // on every render so the visible index can be cycled even before commit
  // — but in this dialog the cycle is "commit immediately" so the proxy
  // ends up reading themeCtx.selected anyway.

  function next(direction: 1 | -1) {
    const cur = section()
    if (cur === "theme") {
      const idx = themes.indexOf(themeCtx.selected)
      const next = themes[(idx + direction + themes.length) % themes.length]
      if (next) themeCtx.set(next)
    } else if (cur === "transparent") {
      themeCtx.setTransparentBackground(!themeCtx.transparentBackground)
    }
  }

  function cycleSection(direction: 1 | -1) {
    const i = SECTION_ORDER.indexOf(section())
    const next = SECTION_ORDER[(i + direction + SECTION_ORDER.length) % SECTION_ORDER.length] ?? "theme"
    setSection(next)
  }

  useBindings(() => ({
    bindings: [
      { key: "tab", cmd: () => cycleSection(+1) },
      { key: "shift+tab", cmd: () => cycleSection(-1) },
      { key: "left", cmd: () => next(-1) },
      { key: "right", cmd: () => next(+1) },
      { key: "h", cmd: () => next(-1) },
      { key: "l", cmd: () => next(+1) },
      {
        key: "return",
        cmd: () => {
          props.onClose()
          dialog.clear()
        },
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Settings
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onClose()}>
          esc
        </text>
      </box>

      <box flexDirection="column" gap={0}>
        <box flexDirection="row" gap={1}>
          <text fg={section() === "theme" ? theme.accent : theme.textMuted}>theme</text>
          <text fg={theme.textMuted}>← / →</text>
        </box>
        <text fg={section() === "theme" ? theme.text : theme.textMuted}>{themeCtx.selected}</text>
      </box>

      <box flexDirection="column" gap={0}>
        <box flexDirection="row" gap={1}>
          <text fg={section() === "transparent" ? theme.accent : theme.textMuted}>transparent bg</text>
          <text fg={theme.textMuted}>← / →</text>
        </box>
        <text fg={section() === "transparent" ? theme.text : theme.textMuted}>
          {themeCtx.transparentBackground ? "on" : "off"}
        </text>
      </box>

      <box flexDirection="column" gap={0}>
        <text fg={section() === "repos" ? theme.accent : theme.textMuted}>saved repos</text>
        <Show
          when={repos.length > 0}
          fallback={<text fg={theme.textMuted}>(none — run "kobe add &lt;path&gt;" from a shell)</text>}
        >
          <For each={repos}>{(r) => <text fg={theme.textMuted}>{r}</text>}</For>
        </Show>
      </box>

      <box paddingBottom={1}>
        <text fg={theme.textMuted}>tab section · ←/→ change · enter close · esc cancel</text>
      </box>
    </box>
  )
}

export const SettingsDialog = {
  show(dialog: DialogContext): Promise<void> {
    return new Promise<void>((resolve) => {
      dialog.replace(
        () => <SettingsDialogView onClose={() => resolve()} />,
        () => resolve(),
      )
      dialog.setSize("medium")
    })
  },
}
