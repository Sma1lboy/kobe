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
import { For, Show, createMemo, createSignal } from "solid-js"
import type { KVContext } from "../context/kv"
import { useTheme } from "../context/theme"
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
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const [section, setSection] = createSignal<SectionId>("general")
  const [cursor, setCursor] = createSignal(0)

  // Theme picker state — separate cursor from section sidebar's. Defaults
  // to the currently-active theme so an immediate enter is a no-op rather
  // than a surprise switch.
  const themeNames = createMemo<readonly string[]>(() => themeCtx.all().slice().sort())
  const [themeCursor, setThemeCursor] = createSignal(
    Math.max(
      0,
      themeNames().findIndex((n) => n === themeCtx.selected),
    ),
  )

  function moveCursor(delta: number): void {
    if (section() === "general") {
      // Theme list nav.
      const len = themeNames().length
      if (len === 0) return
      setThemeCursor((c) => (c + delta + len) % len)
      return
    }
    setCursor((c) => (c + delta + SECTIONS.length) % SECTIONS.length)
    const next = SECTIONS[cursor()]
    if (next) setSection(next.id)
  }

  function switchSection(id: SectionId): void {
    setSection(id)
    setCursor(SECTIONS.findIndex((s) => s.id === id))
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
      // `enter` activates the focused row in the current section.
      // General → set theme to the highlighted entry. Dev → reset.
      {
        key: "return",
        cmd: () => {
          if (section() === "general") {
            const name = themeNames()[themeCursor()]
            if (name) themeCtx.set(name)
            return
          }
          if (section() === "dev") void confirmReset()
        },
      },
      // Left/right jumps focus between section sidebar and section
      // body — useful when a list is open and the user wants to pop
      // back to switching sections without using j/k.
      {
        key: "left",
        cmd: () => {
          // Moving left from any section returns focus to the section
          // sidebar — repurpose `cursor` as the active sidebar row.
          setSection("general")
          setCursor(0)
        },
      },
      // `t` toggles the transparent-bg flag from the General section.
      // Bare letter is fine here — the dialog isn't an input surface,
      // so we don't conflict with composer-style typing.
      {
        key: "t",
        cmd: () => {
          if (section() === "general") themeCtx.setTransparentBackground(!themeCtx.transparentBackground)
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
                  onMouseUp={() => switchSection(s.id)}
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
            <box flexDirection="column" gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Theme
              </text>
              <text fg={theme.textMuted}>↑↓ to highlight, enter to apply.</text>
              <box flexDirection="column" gap={0}>
                <For each={themeNames()}>
                  {(name, i) => {
                    const isCursor = () => i() === themeCursor()
                    const isSelected = () => name === themeCtx.selected
                    return (
                      <box
                        flexDirection="row"
                        gap={1}
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={isCursor() ? theme.primary : undefined}
                        onMouseUp={() => {
                          setThemeCursor(i())
                          themeCtx.set(name)
                        }}
                      >
                        <text
                          fg={isCursor() ? theme.selectedListItemText : isSelected() ? theme.accent : theme.text}
                          attributes={isCursor() || isSelected() ? TextAttributes.BOLD : undefined}
                          wrapMode="none"
                        >
                          {isSelected() ? "● " : "  "}
                          {name}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>
              {/* Transparent-bg toggle — orthogonal to theme. Lets the host
                  terminal's bg / image / opacity show through while the
                  active palette controls every other token. Toggle with
                  `t`. */}
              <box flexDirection="column" gap={0} paddingTop={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Transparent background
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  Drops the renderer's bg fill so the host terminal shows through. `t` toggles.
                </text>
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseUp={() => themeCtx.setTransparentBackground(!themeCtx.transparentBackground)}
                >
                  <text
                    fg={themeCtx.transparentBackground ? theme.accent : theme.textMuted}
                    attributes={TextAttributes.BOLD}
                    wrapMode="none"
                  >
                    {themeCtx.transparentBackground ? "[x] on" : "[ ] off"}
                  </text>
                </box>
              </box>
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
