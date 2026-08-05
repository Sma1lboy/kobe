/**
 * ChatShell — kobe as a windowed TERMINAL app (/chat, hosted by the
 * kobe-desktop Electron shell). ONE surface, no modes: the task's engine
 * PTY runs the real CLI, and what you SEE is its screen translated to HTML
 * (TtyBlocksView over lib/claude-tty.ts) with the GUI composer standing in
 * for the native input row. The raw xterm stays mounted underneath as the
 * data source and takes over the pixels automatically only while a native
 * dialog owns the screen (permission prompt, menu) — answer it, and the
 * translated render returns. No view toggle, no second transcript.
 *
 * Left rail mirrors the TUI tree sidebar; right is a collapsed-by-default
 * Changes placeholder. One PTY per task tab — the same one the workspace
 * vendor tab attaches.
 */

import { CornerDownLeft, PanelRight } from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { findClaudeInputRegion } from "../lib/claude-input.ts"
import { useAppState } from "../lib/store.ts"
import { ensureEngineTab } from "../lib/tabs.ts"
import type { ColoredLine } from "../lib/tty-color.ts"
import { ChatSidebarTree } from "./ChatSidebarTree.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { Toasts } from "./Toasts.tsx"
import { TtyBlocksView } from "./TtyBlocksView.tsx"

const ChatTerminal = lazy(() =>
  import("./ChatTerminal.tsx").then((m) => ({ default: m.ChatTerminal })),
)

/** Right rail — a collapsed-by-default file-changes placeholder. The real
 *  Changes pane (diff list) lands here once the core loop is proven; for now
 *  it only shows the uncommitted ± counts so the rail earns its width. */
function ChangesPanel({
  changes,
  onCollapse,
}: {
  changes: { added: number; deleted: number } | undefined
  onCollapse: () => void
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-subtle">
          Changes
        </span>
        <button
          type="button"
          onClick={onCollapse}
          className="text-[11px] text-subtle hover:text-fg"
          title="Collapse"
          aria-label="Collapse changes panel"
        >
          ⇥
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-3 text-center">
        {changes && (changes.added > 0 || changes.deleted > 0) ? (
          <span className="font-mono text-[13px]">
            <span className="text-kobe-green">+{changes.added}</span>{" "}
            <span className="text-kobe-red">−{changes.deleted}</span>
          </span>
        ) : (
          <span className="font-mono text-[12px] text-subtle">clean</span>
        )}
        <span className="text-[11px] text-subtle">File changes land here.</span>
      </div>
    </aside>
  )
}

/** One translated status line from the engine's own footer (branch | ctx |
 *  quota | mode). Warning lines (⚠) go yellow; the rest stay muted mono. */
function StatusLine({ text }: { text: string }) {
  const warning = text.includes("⚠")
  return (
    <div
      className={`truncate font-mono text-[11px] leading-[1.6] ${
        warning ? "text-kobe-yellow" : "text-subtle"
      }`}
    >
      {text}
    </div>
  )
}

/** Entry-to-native input bar (translated view). Clicking it hands input to
 *  the real CLI: the raw terminal takes over, focused, so the user types
 *  natively — slash-command menus, @-complete, arrow selection, the lot.
 *  It's a button, not a textarea, so there's no race for the first
 *  keystroke; the native terminal owns every key from the click on. */
function EntryBar({ onActivate }: { onActivate: () => void }) {
  return (
    <div className="px-4 py-3">
      <button
        type="button"
        onClick={onActivate}
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-left text-[13px] text-subtle transition-colors hover:border-line-active"
      >
        <span className="flex-1">Type to the agent…</span>
        <CornerDownLeft size={13} strokeWidth={2.2} className="text-subtle" />
      </button>
    </div>
  )
}

/**
 * One live TTY, one render, native input. Every buffer frame splits at
 * Claude Code's input region (lib/claude-input.ts): the BODY re-renders as
 * colored HTML lines (lib/claude-tty.ts), the input region drives the entry
 * bar + translated status lines. INPUT is always the real CLI — clicking the
 * entry bar (or a native dialog needing an answer) hands the raw terminal
 * the keyboard, so slash-command menus / completions / arrow selection all
 * work natively; when the turn submits (input clears) the translated render
 * returns to show output.
 */
function SessionView({
  tabId,
  taskId,
  needsInput,
}: {
  tabId: string
  taskId: string
  needsInput: boolean
}) {
  const [colored, setColored] = useState<ColoredLine[]>([])

  // The body/input split derives from the buffer per render — frames
  // stream at animation rate but React re-renders only on text change.
  const textLines = useMemo(() => colored.map((l) => l.text), [colored])
  const region = useMemo(() => findClaudeInputRegion(textLines), [textLines])
  const bodyLines = useMemo(
    () => (region ? colored.slice(0, region.topRow) : colored),
    [region, colored],
  )
  const hasScreen = colored.length > 0
  const promptText = region?.promptText ?? ""

  // `typing`: the user handed input to the native CLI (clicked the entry
  // bar). It ends on the falling edge of the native input — once they've
  // typed something and then the input clears (submitted, or Esc-cleared),
  // the translated render returns to show output. sawInputRef guards the
  // initial empty prompt from counting as a submit.
  const [typing, setTyping] = useState(false)
  const sawInputRef = useRef(false)
  useEffect(() => {
    if (!typing) return
    if (promptText !== "") sawInputRef.current = true
    else if (sawInputRef.current) {
      sawInputRef.current = false
      setTyping(false)
    }
  }, [typing, promptText])

  // Raw terminal shows (and owns the keyboard) when the user is typing, OR
  // when a native dialog needs answering (permission prompt / menu that made
  // the composer grammar vanish). Otherwise the translated render is up.
  const seenRegionRef = useRef(false)
  if (region !== null) seenRegionRef.current = true
  const dialogTakeover =
    needsInput || (seenRegionRef.current && region === null && hasScreen)
  const rawMode = typing || dialogTakeover

  return (
    <div className="relative h-full">
      {/* The real PTY — always mounted (it IS the data source AND the input
          target). Visible while typing or a dialog needs answering.
          `invisible` (not `hidden`) so xterm keeps real dimensions. */}
      <div className={`absolute inset-0 ${rawMode ? "" : "invisible"}`}>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-[12px] text-subtle">
              Attaching terminal…
            </div>
          }
        >
          <ChatTerminal
            key={tabId}
            tabId={tabId}
            taskId={taskId}
            mode="engine"
            hideComposer
            active={rawMode}
            onColoredBuffer={setColored}
          />
        </Suspense>
      </div>
      {!rawMode && (
        <div className="relative z-10 flex h-full flex-col bg-bg">
          <div className="min-h-0 flex-1">
            <TtyBlocksView lines={bodyLines} />
          </div>
          <div className="shrink-0 border-t border-line bg-surface">
            <EntryBar onActivate={() => setTyping(true)} />
            {region && region.statusLines.length > 0 && (
              <div className="px-4 pb-2">
                {region.statusLines.map((line) => (
                  <StatusLine key={line} text={line} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function ChatShell() {
  const { tasks, activeTaskId, engineStates, worktreeChanges } = useAppState()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const live = useMemo(() => tasks.filter((t) => !t.archived), [tasks])
  const selected =
    live.find((t) => t.id === selectedId) ??
    live.find((t) => t.id === activeTaskId) ??
    live[0] ??
    null

  const engine = selected ? engineStates[selected.id] : undefined
  // The daemon's activity registry emits "permission_needed"; older web code
  // (activity.ts) still matches "waiting_permission" — accept both here.
  const needsInput =
    engine?.state === "waiting_permission" ||
    engine?.state === "permission_needed"

  // Same tab id the workspace vendor tab uses — both surfaces share one PTY.
  // ensureEngineTab mutates the tabs store, so resolve it in an effect (not
  // during render).
  const selectedTaskId = selected?.id ?? null
  const [tabId, setTabId] = useState<string | null>(null)
  useEffect(() => {
    setTabId(selectedTaskId ? ensureEngineTab(selectedTaskId) : null)
  }, [selectedTaskId])

  // Right rail: collapsed by default — the sidebar already tells the status
  // story; the rail returns when the file-changes pane earns it.
  const [showChanges, setShowChanges] = useState(false)

  return (
    <div className="flex h-full flex-col bg-bg">
      <DaemonBanner />
      <div className="flex min-h-0 flex-1">
        <ChatSidebarTree
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
        />

        {selected ? (
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
              <span className="min-w-0 truncate text-[13px] text-fg">
                {selected.title || selected.branch}
              </span>
              <button
                type="button"
                onClick={() => setShowChanges((cur) => !cur)}
                aria-pressed={showChanges}
                className={`ml-auto flex items-center gap-1 rounded-sm border px-2 py-1 text-[11px] transition-colors ${
                  showChanges
                    ? "border-line-active bg-inset text-fg"
                    : "border-line text-subtle hover:text-fg"
                }`}
                title="Toggle the file-changes panel"
              >
                <PanelRight size={12} strokeWidth={2} />
              </button>
            </div>
            <div className="relative min-h-0 flex-1">
              {tabId && (
                <SessionView
                  key={tabId}
                  tabId={tabId}
                  taskId={selected.id}
                  needsInput={needsInput}
                />
              )}
            </div>
          </main>
        ) : (
          <main className="flex flex-1 items-center justify-center text-[12px] text-subtle">
            No sessions — create a task first.
          </main>
        )}

        {selected && showChanges && (
          <ChangesPanel
            changes={
              selected.worktreePath
                ? worktreeChanges[selected.worktreePath]
                : undefined
            }
            onCollapse={() => setShowChanges(false)}
          />
        )}
      </div>
      <Toasts />
    </div>
  )
}
