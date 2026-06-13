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
    label: "Command palette — jump to a task or run an action",
  },
  { keys: ["j", "k"], label: "Move between tasks in the rail (also ↑ / ↓)" },
  {
    keys: ["/"],
    label: "Focus the task filter — then ↵ jumps to the top match, esc clears",
  },
  { keys: ["?"], label: "This help" },
  { keys: ["esc"], label: "Close a dialog / palette / help" },
]

const PALETTE: Shortcut[] = [
  { keys: ["↑", "↓"], label: "Move selection" },
  { keys: ["↵"], label: "Run the selected command" },
  { keys: ["theme"], label: 'Type "theme" to switch theme (or Follow TUI)' },
]

const COMPOSER: Shortcut[] = [
  { keys: ["↑", "↓"], label: "Recall previously-sent prompts (newest first)" },
  { keys: ["↵"], label: "Send · Shift+↵ for a newline" },
]

const AFFORDANCES: Array<{ label: string; detail: string }> = [
  {
    label: "New task",
    detail: "the + in the task rail (or palette → New task)",
  },
  {
    label: "Adopt worktree",
    detail: "the folder-in icon next to + — pull an existing worktree in",
  },
  {
    label: "Overview",
    detail:
      "the grid icon in the top bar — triage every task at once; j/k highlight, Enter opens",
  },
  {
    label: "Chat / Vendor / Terminal",
    detail:
      "tab kinds inside a task workspace; Chat has search, a hide-tools toggle, and copy-as-Markdown",
  },
  {
    label: "Triage",
    detail:
      "rail status chips (All/Needs/Run/Dirty) + the Overview grid — filter by what needs you",
  },
  {
    label: "Changes / diff",
    detail: "filter files by path, toggle line wrap on a file preview",
  },
  {
    label: "Conflicts",
    detail:
      "a ⚠ on a task (rail / Overview / board) means its branch collides with another in-flight task — red = real merge conflict, yellow = file overlap; hover for who + which files",
  },
  {
    label: "Copy link",
    detail: "Task panel → Copy link — share a deep link to a task",
  },
  {
    label: "Needs you",
    detail:
      'the tab title shows "(N) kobe" when N tasks are waiting; Cmd+K → "Go to next task needing you" jumps straight to them',
  },
  {
    label: "Notifications",
    detail: "Settings → Notifications — get pinged when a task needs you",
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
              In the command palette
            </div>
            {PALETTE.map((s) => (
              <Row key={s.label} {...s} />
            ))}
          </section>
          <section>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
              In the engine composer
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
