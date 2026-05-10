/**
 * Command palette — registry + dialog launcher.
 *
 * Adapted from `refs/opencode/packages/opencode/src/cli/cmd/tui/context/command-palette.tsx`.
 * Opencode's version is wired through `@opentui/keymap`'s command system,
 * which we don't depend on. The kobe variant keeps the same public hooks
 * (`useCommandPalette`, `useCommandSlashes`) but stores the registry as a
 * plain reactive list.
 *
 * The command list (formerly opencode's `appCommands`) is **empty**. kobe's
 * orchestrator and individual streams will register their own commands here
 * via `addCommand(...)` once they exist; for 0.2 we just need the surface to
 * be present so the palette dialog can be opened (proves the dialog stack is
 * wired) and `useCommandSlashes` returns an empty list cleanly.
 */

import { TextAttributes } from "@opentui/core"
import {
  type Accessor,
  For,
  type ParentProps,
  Show,
  createContext,
  createMemo,
  createSignal,
  useContext,
} from "solid-js"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"
import { useTheme } from "./theme"

export type CommandEntry = {
  /** Stable id, e.g. `task.new`. */
  name: string
  /** Human-readable title shown in the palette. */
  title: string
  /** Optional description / help text. */
  desc?: string
  /** Optional grouping label. */
  category?: string
  /** Slash-command shortcut, e.g. `new` for `/new`. */
  slashName?: string
  /** Aliases for the slash form. */
  slashAliases?: string[]
  /** Hidden from the palette UI (still callable by id). */
  hidden?: boolean
  /** Callback fired when the entry is selected. */
  run: () => void
}

export type SlashEntry = {
  display: string
  description?: string
  aliases?: string[]
  onSelect: () => void
}

export type CommandPaletteContext = {
  /** Run a registered command by its id. */
  run(name: string): void
  /** Open the palette dialog. */
  show(): void
  /** Reactive list of slash entries — for chat composer autocomplete later. */
  slashes: Accessor<readonly SlashEntry[]>
  /** Add a command at runtime. Returns an unregister fn. */
  addCommand(entry: CommandEntry): () => void
  /** All non-hidden registered commands. */
  list: Accessor<readonly CommandEntry[]>
}

const ctx = createContext<CommandPaletteContext>()

export function CommandPaletteProvider(props: ParentProps) {
  const dialog = useDialog()
  const [commands, setCommands] = createSignal<readonly CommandEntry[]>([])

  function addCommand(entry: CommandEntry): () => void {
    setCommands((prev) => [...prev, entry])
    return () => {
      setCommands((prev) => prev.filter((c) => c !== entry))
    }
  }

  function run(name: string) {
    const cmd = commands().find((c) => c.name === name)
    cmd?.run()
  }

  const slashes = createMemo<readonly SlashEntry[]>(() =>
    commands().flatMap((c) => {
      if (!c.slashName) return []
      return [
        {
          display: `/${c.slashName}`,
          description: c.desc ?? c.title,
          aliases: c.slashAliases?.map((a) => `/${a}`),
          onSelect: () => run(c.name),
        },
      ]
    }),
  )

  const visible = createMemo(() => commands().filter((c) => !c.hidden))

  const value: CommandPaletteContext = {
    run,
    show() {
      dialog.replace(() => <CommandPaletteDialog list={visible()} run={run} />)
    },
    slashes,
    addCommand,
    list: visible,
  }

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useCommandPalette(): CommandPaletteContext {
  const value = useContext(ctx)
  if (!value) throw new Error("useCommandPalette must be used within a CommandPaletteProvider")
  return value
}

export function useCommandSlashes(): Accessor<readonly SlashEntry[]> {
  return useCommandPalette().slashes
}

/**
 * Tiny inline palette dialog — meant to be replaced by a richer DialogSelect
 * lift later. We render the registered commands (or an empty-state message),
 * arrow up/down to move, enter to run, esc handled by the dialog stack.
 */
function CommandPaletteDialog(props: { list: readonly CommandEntry[]; run: (name: string) => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal(0)

  const list = () => props.list

  function move(delta: number) {
    const len = list().length
    if (len === 0) return
    setSelected((cur) => (cur + delta + len) % len)
  }

  useBindings(() => ({
    enabled: dialog.stack.length > 0,
    bindings: [
      { key: "up", cmd: () => move(-1) },
      { key: "down", cmd: () => move(1) },
      { key: "k", cmd: () => move(-1) },
      { key: "j", cmd: () => move(1) },
      {
        key: "return",
        cmd: () => {
          const item = list()[selected()]
          if (!item) {
            dialog.clear()
            return
          }
          dialog.clear()
          props.run(item.name)
        },
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Commands
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show
        when={list().length > 0}
        fallback={
          <box paddingBottom={1}>
            <text fg={theme.textMuted}>No commands registered yet.</text>
          </box>
        }
      >
        <box paddingBottom={1}>
          <For each={list()}>
            {(entry, idx) => {
              const active = () => idx() === selected()
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.primary : undefined}
                  onMouseUp={() => {
                    dialog.clear()
                    props.run(entry.name)
                  }}
                >
                  <text fg={active() ? theme.selectedListItemText : theme.text}>{entry.title}</text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}
