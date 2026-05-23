/**
 * Help dialog (v0.6).
 *
 * Static chord cheat-sheet. v0.5's help was generated from KobeKeymap
 * — that registry shrank a lot in v0.6 and most of its remaining
 * machinery isn't wired here yet, so we just hand-list the chords
 * the app.tsx Shell actually binds.
 */

import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

const SECTIONS: ReadonlyArray<{ heading: string; rows: ReadonlyArray<[string, string]> }> = [
  {
    heading: "Global",
    rows: [
      ["ctrl+c", "force quit"],
      ["q", "quit (confirm)"],
      ["?  /  F1", "this help"],
      ["tab  /  shift+tab", "cycle pane focus"],
      ["ctrl+1  /  ctrl+2", "jump to sidebar / workspace"],
      ["ctrl+d", "toggle cost dashboard"],
    ],
  },
  {
    heading: "Sidebar",
    rows: [
      ["n", "new task"],
      ["r", "rename task"],
      ["a", "archive / unarchive"],
      ["d", "delete task (confirm)"],
      ["s", "settings"],
      ["shift+P", "pin / unpin"],
      ["j / k  or  ↑/↓", "move cursor"],
    ],
  },
  {
    heading: "Workspace",
    rows: [
      ["⏎  /  enter", "attach to task's tmux session"],
      ["ctrl+q", "(inside tmux) detach back to kobe"],
      ["ctrl+b d", "(inside tmux) tmux-native detach"],
    ],
  },
]

export function HelpDialogView(props: { onClose: () => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()

  useBindings(() => ({
    bindings: [
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
          Help
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onClose()}>
          esc
        </text>
      </box>
      <For each={SECTIONS}>
        {(section) => (
          <box flexDirection="column" gap={0}>
            <text fg={theme.accent}>{section.heading}</text>
            <For each={section.rows}>
              {([chord, description]) => (
                <box flexDirection="row" gap={2}>
                  <text fg={theme.text}>{padRight(chord, 20)}</text>
                  <text fg={theme.textMuted}>{description}</text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>enter / esc close</text>
      </box>
    </box>
  )
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length)
}

export const HelpDialog = {
  show(dialog: DialogContext): Promise<void> {
    return new Promise<void>((resolve) => {
      dialog.replace(
        () => <HelpDialogView onClose={() => resolve()} />,
        () => resolve(),
      )
      dialog.setSize("medium")
    })
  },
}
