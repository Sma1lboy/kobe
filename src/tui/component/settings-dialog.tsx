/**
 * Settings dialog — two-column layout with a left sidebar (sections)
 * and a right pane (the active section's content).
 *
 * Sections (v1):
 *   - General — placeholder. Real settings land here as we accumulate
 *     things worth toggling (theme, model default, default permission
 *     mode, etc.).
 *   - Dev    — affordances for development / debugging only. Currently
 *     hosts a "Reset UI state" button that wipes the KV store
 *     (`~/.config/kobe/state.json`). Tasks are NOT touched — those
 *     live in `~/.kobe/tasks.json` and need a separate, more
 *     destructive verb that we deliberately don't expose yet.
 *
 * Bindings inside the dialog:
 *   - `↑` / `↓` — navigate the section sidebar.
 *   - `tab`     — same as `↓` (cycles).
 *   - `enter`   — activate the focused button in the section content.
 *   - `esc`     — close (handled by the dialog stack).
 */

import { TextAttributes } from "@opentui/core"
import { For, Show, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import type { KVContext } from "../context/kv"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

type SectionId = "general" | "dev"

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "dev", label: "Dev" },
]

export type SettingsDialogProps = {
  kv: KVContext
  onClose: () => void
}

export function SettingsDialog(props: SettingsDialogProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [section, setSection] = createSignal<SectionId>("general")
  const [cursor, setCursor] = createSignal(0)

  function moveCursor(delta: number): void {
    setCursor((c) => (c + delta + SECTIONS.length) % SECTIONS.length)
    const next = SECTIONS[cursor()]
    if (next) setSection(next.id)
  }

  // Confirm before wiping KV — the user explicitly asked for it but
  // it's still destructive (drops their persisted layout, last-selected
  // task, etc.) and a stray enter on the row shouldn't blow it away.
  async function confirmReset(): Promise<void> {
    const ok = await DialogConfirm.show(
      dialog,
      "Reset UI state?",
      "Wipes ~/.config/kobe/state.json — drops last selected task, open chat tabs, pane sizes, last new-task repo, model picks. Tasks themselves (~/.kobe/tasks.json) are NOT touched.",
      "cancel",
    )
    if (ok !== true) return
    props.kv.clear()
    // Close the settings dialog too — the layout is about to snap to
    // defaults, no point leaving it open.
    props.onClose()
  }

  useBindings(() => ({
    bindings: [
      { key: "down", cmd: () => moveCursor(1) },
      { key: "up", cmd: () => moveCursor(-1) },
      { key: "j", cmd: () => moveCursor(1) },
      { key: "k", cmd: () => moveCursor(-1) },
      { key: "tab", cmd: () => moveCursor(1) },
      // `enter` activates the only actionable thing in the current
      // section. General has nothing; Dev has the reset row.
      {
        key: "return",
        cmd: () => {
          if (section() === "dev") void confirmReset()
        },
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Settings
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onClose()}>
          esc
        </text>
      </box>
      {/* Two-column body: left section list, right active-section content. */}
      <box flexDirection="row" gap={2}>
        {/* Section sidebar */}
        <box flexDirection="column" flexShrink={0} width={14} gap={0}>
          <For each={SECTIONS}>
            {(s, i) => {
              const active = () => i() === cursor()
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.primary : undefined}
                  onMouseUp={() => {
                    setCursor(i())
                    setSection(s.id)
                  }}
                >
                  <text
                    fg={active() ? theme.selectedListItemText : theme.text}
                    attributes={active() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {s.label}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
        {/* Section content */}
        <box flexGrow={1} flexShrink={1} flexDirection="column" gap={1}>
          <Show when={section() === "general"}>
            <box paddingTop={0}>
              <text fg={theme.textMuted}>Nothing here yet.</text>
            </box>
          </Show>
          <Show when={section() === "dev"}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Reset UI state
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                Clears ~/.config/kobe/state.json — pane sizes, last selected task, open chat tabs, model picks. Tasks
                themselves are not touched.
              </text>
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                paddingTop={0}
                paddingBottom={0}
                backgroundColor={theme.backgroundElement}
                onMouseUp={() => {
                  void confirmReset()
                }}
              >
                <text fg={theme.warning} attributes={TextAttributes.BOLD}>
                  [enter] Reset
                </text>
              </box>
            </box>
          </Show>
        </box>
      </box>
      <box paddingTop={0}>
        <text fg={theme.textMuted}>↑↓ pick · enter activate · esc close</text>
      </box>
    </box>
  )
}

SettingsDialog.show = (dialog: DialogContext, kv: KVContext): Promise<void> => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <SettingsDialog kv={kv} onClose={() => resolve()} />,
      () => resolve(),
    )
  })
}
