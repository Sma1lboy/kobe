import type { KobeBinding } from "./keybindings-table.ts"

export const INBOX_BINDINGS: readonly KobeBinding[] = [
  {
    id: "inbox.show",
    scope: "global",
    keys: [],
    prefixKeys: ["i"],
    category: "Global",
    description: "Open attention Inbox",
  },
  {
    id: "inbox.nav",
    scope: "inbox",
    keys: ["j", "k", "down", "up"],
    category: "Inbox",
    description: "Move cursor up/down",
    hint: { keys: "j/k" },
  },
  {
    id: "inbox.open",
    scope: "inbox",
    keys: ["return"],
    category: "Inbox",
    description: "Open the selected task and chat tab",
    hint: { keys: "enter" },
  },
  {
    id: "inbox.delete",
    scope: "inbox",
    keys: ["d"],
    category: "Inbox",
    description: "Delete the selected attention episode",
    hint: { keys: "d" },
  },
]
