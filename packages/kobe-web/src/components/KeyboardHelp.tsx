/**
 * Keyboard help overlay — the web counterpart of the TUI's F1 help. Opened
 * with `?` (when not typing in a field) or a top-bar button; lists the
 * shortcuts and the main affordances so they're discoverable. Esc closes.
 */

import { useEffect, useRef } from "react"
import { useFocusTrap } from "../lib/use-focus-trap.ts"

interface Shortcut {
  keys: string[]
  label: string
}

const SHORTCUTS: Shortcut[] = [
  {
    keys: ["⌘", "K"],
    label: "Command palette — hold ctrl and tap K to cycle, release to jump",
  },
  { keys: ["ctrl", "T"], label: "New tab on the selected task (same engine)" },
  { keys: ["ctrl", "E"], label: "New tab — pick an engine, or a native shell" },
  { keys: ["ctrl", "W"], label: "Close the active tab" },
  { keys: ["ctrl", "2-0"], label: "Jump to the tab printing that digit" },
  {
    keys: ["ctrl", "A"],
    label: "Prefix — then 1 Kanban · 2 Routines · i Inbox",
  },
  { keys: ["j", "k"], label: "Tree cursor from the selected row · ↵ activates" },
  { keys: ["[", "]"], label: "Active ⇄ Archives view" },
  { keys: ["/"], label: "Focus the sidebar search" },
  { keys: ["?"], label: "This help" },
  { keys: ["esc"], label: "Close a dialog / palette / help" },
]

const INBOX: Shortcut[] = [
  { keys: ["j", "k"], label: "Move · ↵ opens the item" },
  { keys: ["d"], label: "Dismiss the selected attention item" },
]

const COMPOSER: Shortcut[] = [
  { keys: ["↵"], label: "Send — keystrokes drive the real CLI underneath" },
  { keys: ["/"], label: "Native slash menu (arrow keys move its selection)" },
  { keys: ["ctrl", "V"], label: "Paste an image from the clipboard" },
]

const AFFORDANCES: Array<{ label: string; detail: string }> = [
  {
    label: "New task",
    detail: "the [+] in the sidebar header (or palette → New task)",
  },
  {
    label: "Copy",
    detail:
      "hover a reply for the copy button below it, or drag-select any text",
  },
  {
    label: "Kanban / Routines",
    detail: "sidebar rail (or ctrl+a then 1 / 2) — embedded in this window",
  },
  {
    label: "Shell tabs",
    detail:
      "ctrl+e → Shell runs your login shell; launching an engine inside it lights the session up",
  },
  {
    label: "Settings / help",
    detail: "the gear and ? at the sidebar's bottom-left",
  },
]

function Keycap({ k }: { k: string }) {
  return (
    <kbd className="inline-flex min-w-[1.4rem] items-center justify-center border border-line bg-inset px-1.5 py-0.5 font-mono text-[11px] text-fg">
      {k}
    </kbd>
  )
}

function Row({ keys, label }: Shortcut) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k) => (
          <Keycap key={k} k={k} />
        ))}
      </span>
      <span className="min-w-0 flex-1 text-[12px] text-muted">{label}</span>
    </div>
  )
}

export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss; Escape + the close button are the keyboard paths.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onKeyDown={() => {}}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="w-[30rem] max-w-[calc(100vw-2rem)] border border-line bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={() => {}}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
            Keyboard & shortcuts
          </span>
          <kbd className="border border-line px-1.5 py-0.5 font-mono text-[10px] text-subtle">
            esc
          </kbd>
        </div>
        <div className="space-y-4 px-4 py-3">
          <section>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Global
            </div>
            {SHORTCUTS.map((s) => (
              <Row key={s.label} {...s} />
            ))}
          </section>
          <section>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              In the Inbox (ctrl+a, i)
            </div>
            {INBOX.map((s) => (
              <Row key={s.label} {...s} />
            ))}
          </section>
          <section>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              In the composer
            </div>
            {COMPOSER.map((s) => (
              <Row key={s.label} {...s} />
            ))}
          </section>
          <section>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              Where things are
            </div>
            {AFFORDANCES.map((a) => (
              <div
                key={a.label}
                className="flex items-baseline gap-2 py-0.5 text-[12px]"
              >
                <span className="shrink-0 font-semibold text-fg">
                  {a.label}
                </span>
                <span className="min-w-0 flex-1 text-subtle">{a.detail}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}
