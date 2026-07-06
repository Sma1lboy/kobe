import { createSignal } from "solid-js"
import type { Binding } from "../lib/keymap"
import { CHAT_BINDINGS } from "./keybindings-chat.ts"
import { FILES_BINDINGS } from "./keybindings-files.ts"
import { SIDEBAR_BINDINGS } from "./keybindings-sidebar.ts"

export type KobeBindingScope = "global" | "sidebar" | "workspace" | "files" | "terminal"

export type KobeBindingHint = {
  keys: string
  label: string
  status?: false
  pin?: "right"
}

export type KobeBinding = {
  id: string
  scope: KobeBindingScope
  keys: readonly string[]
  category: string
  description: string
  hint?: KobeBindingHint
}

export const KobeKeymap: readonly KobeBinding[] = [
  {
    id: "help.open",
    scope: "global",
    keys: ["f1"],
    category: "Global",
    description: "Show keybindings help",
    hint: { keys: "F1", label: "help", pin: "right" },
  },
  {
    id: "task.new",
    scope: "sidebar",
    keys: ["n"],
    category: "Sidebar",
    description: "New task",
    hint: { keys: "n", label: "new" },
  },
  {
    id: "task.openEditor",
    scope: "global",
    keys: ["ctrl+o"],
    category: "Global",
    description: "Open active task worktree in editor",
  },
  {
    id: "settings.open",
    scope: "global",
    keys: ["ctrl+,"],
    category: "Global",
    description: "Open settings",
  },
  {
    id: "settings.open.sidebar",
    scope: "sidebar",
    keys: ["s"],
    category: "Sidebar",
    description: "Open settings",
    hint: { keys: "s", label: "settings", status: false },
  },
  {
    id: "worktrees.open.sidebar",
    scope: "sidebar",
    keys: ["x"],
    category: "Sidebar",
    description: "Open worktrees",
    hint: { keys: "x", label: "worktrees", status: false },
  },
  {
    id: "app.quit",
    scope: "sidebar",
    keys: ["q", "ctrl+q"],
    category: "Sidebar",
    description: "Quit (with confirm)",
    hint: { keys: "q", label: "quit", status: false },
  },
  {
    id: "focus.sidebar",
    scope: "workspace",
    keys: ["ctrl+q"],
    category: "Workspace",
    description: "Back to sidebar (tasks)",
    hint: { keys: "ctrl+q", label: "tasks" },
  },

  {
    id: "focus.numeric",
    scope: "global",
    keys: ["ctrl+h", "ctrl+j", "ctrl+k", "ctrl+l"],
    category: "Navigation",
    description: "Jump to pane (h=sidebar, j=workspace, k=files, l=terminal)",
    hint: { keys: "ctrl+hjkl", label: "focus", pin: "right", status: false },
  },
  {
    id: "chat.interrupt",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Interrupt current turn (esc while streaming)",
  },
  ...SIDEBAR_BINDINGS,

  ...CHAT_BINDINGS,

  ...FILES_BINDINGS,

  {
    id: "terminal.scroll-up",
    scope: "terminal",
    keys: ["ctrl+pageup"],
    category: "Terminal",
    description: "Scroll scrollback up",
    hint: { keys: "ctrl+pgup", label: "scroll", status: false },
  },
  {
    id: "terminal.scroll-down",
    scope: "terminal",
    keys: ["ctrl+pagedown"],
    category: "Terminal",
    description: "Scroll scrollback down",
  },
  {
    id: "terminal.reset",
    scope: "terminal",
    keys: ["f5"],
    category: "Terminal",
    description: "Reset terminal — kill the current shell and respawn",
    hint: { keys: "f5", label: "reset" },
  },

  {
    id: "dialog.cancel",
    scope: "global",
    keys: [],
    category: "Dialog",
    description: "Close the top dialog (esc)",
  },
  {
    id: "dialog.newtask.tab.cycle",
    scope: "global",
    keys: [],
    category: "Dialog",
    description: "Switch New Task tab (Existing / New Repo)",
    hint: { keys: "ctrl+[/]", label: "tab" },
  },
] as const

const KEYMAP_DEFAULTS: ReadonlyMap<string, { keys: readonly string[]; hint?: KobeBindingHint }> = new Map(
  KobeKeymap.map((b) => [b.id, { keys: [...b.keys], hint: b.hint ? { ...b.hint } : undefined }]),
)

export function resetKeymapToDefaults(): void {
  for (const row of KobeKeymap) {
    const def = KEYMAP_DEFAULTS.get(row.id)
    if (!def) continue
    const mutable = row as { keys: readonly string[]; hint?: KobeBindingHint }
    mutable.keys = [...def.keys]
    mutable.hint = def.hint ? { ...def.hint } : undefined
  }
}

const [keymapVersion, setKeymapVersion] = createSignal(0)
export { keymapVersion }

const keymapVersionListeners = new Set<() => void>()

export function subscribeKeymapVersion(listener: () => void): () => void {
  keymapVersionListeners.add(listener)
  return () => {
    keymapVersionListeners.delete(listener)
  }
}

export function bumpKeymapVersion(): void {
  setKeymapVersion((v) => v + 1)
  for (const listener of [...keymapVersionListeners]) listener()
}

const KEYMAP_BY_ID: ReadonlyMap<string, KobeBinding> = new Map(KobeKeymap.map((b) => [b.id, b]))

export function findBinding(id: string): KobeBinding | undefined {
  return KEYMAP_BY_ID.get(id)
}

export function chordsOf(id: string): readonly string[] {
  return findBinding(id)?.keys ?? []
}

export function bindByIds(handlers: Record<string, Binding["cmd"]>): Binding[] {
  const out: Binding[] = []
  for (const id in handlers) {
    const cmd = handlers[id]
    if (!cmd) continue
    const chords = chordsOf(id)
    if (chords.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[kobe/keybindings] bindByIds: id="${id}" has no chords (or doesn't exist in KobeKeymap)`)
      continue
    }
    chords.forEach((c, slot) => out.push({ key: c, cmd, slot }))
  }
  return out
}
