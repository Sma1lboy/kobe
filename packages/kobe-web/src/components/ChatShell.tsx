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

import { PanelRight } from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { findClaudeInputRegion } from "../lib/claude-input.ts"
import { useAppState } from "../lib/store.ts"
import { ensureEngineTab } from "../lib/tabs.ts"
import type { ColoredLine } from "../lib/tty-color.ts"
import { ChatSidebarTree } from "./ChatSidebarTree.tsx"
import { DaemonBanner } from "./DaemonBanner.tsx"
import { InputMirror } from "./InputMirror.tsx"
import { Toasts } from "./Toasts.tsx"
import { TtyBlocksView, TtyFooter, useTtyBlocks } from "./TtyBlocksView.tsx"

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

/** One status-footer line (branch | ctx | quota | mode), rendered from the
 *  colored buffer so it keeps the engine's own ANSI colors (blue branch,
 *  cyan tok/s, orange diff, red bypass-permissions). Uncolored runs fall to
 *  muted grey. */
function StatusLine({ line }: { line: ColoredLine }) {
  return (
    <div className="truncate font-mono text-[11px] leading-[1.6] text-subtle">
      {line.segs.map((seg, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: colored runs are positional, re-derived per frame
          key={i}
          style={seg.color ? { color: seg.color } : undefined}
        >
          {seg.text}
        </span>
      ))}
    </div>
  )
}

/** A horizontal-rule row (the composer's frame lines) — dropped from status. */
const STATUS_RULE = /^[─━═╌╍-]{3,}\s*$/

/**
 * One live TTY, ALWAYS translated. The engine PTY lives hidden underneath as
 * the data source AND the input target; the visible surface is always the
 * translated render (lib/claude-tty.ts colored blocks) — it never swaps for a
 * raw terminal. Clicking anywhere focuses the hidden terminal, so keystrokes
 * drive the real CLI directly (slash-command menus, @-complete, arrow
 * selection). Because those live in the PTY's own screen, they come back
 * through the colored buffer and render as translated blocks — the menu you
 * see when you type `/` is the native menu, re-rendered, not a reimplementation
 * and not a jump to a bare terminal.
 */
function SessionView({
  tabId,
  taskId,
  sessionId,
}: {
  tabId: string
  taskId: string
  sessionId: string | null
}) {
  const [colored, setColored] = useState<ColoredLine[]>([])
  const [focusNonce, setFocusNonce] = useState(0)

  // Split each frame at the engine's input region: everything above it is the
  // conversation body, the region itself is the current input line + status.
  const textLines = useMemo(() => colored.map((l) => l.text), [colored])
  const region = useMemo(() => findClaudeInputRegion(textLines), [textLines])
  const bodyLines = useMemo(
    () => (region ? colored.slice(0, region.topRow) : colored),
    [region, colored],
  )
  const promptText = region?.promptText ?? ""
  // Status footer (branch | ctx | quota | mode) as COLORED lines, straight
  // from the buffer below the prompt — so it keeps the engine's ANSI colors
  // instead of flattening to grey. Rule/blank rows dropped.
  const statusColored = useMemo(() => {
    if (!region) return []
    return colored.slice(region.promptRow + 1).filter((l) => {
      const t = l.text.trim()
      return t !== "" && !STATUS_RULE.test(t)
    })
  }, [region, colored])
  // The live footer (spinner/tip/slash-menu below the last gap) is lifted out
  // of the scroll body and floated just above the input row — where the native
  // TUI shows it — instead of leaving it adrift in the history.
  const { body, footer } = useTtyBlocks(bodyLines)
  // A bordered card is only warranted when the engine is WAITING on the user
  // (spinner / slash-menu / question). Passive notices (clipboard hint) get a
  // quiet unboxed line instead.
  const footerInteractive = footer.some(
    (b) => b.kind === "menu" || b.kind === "options" || b.kind === "activity",
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click anywhere focuses the hidden terminal so typing drives the native CLI
    <div
      className="relative h-full"
      onMouseDown={() => setFocusNonce((n) => n + 1)}
    >
      {/* Hidden real PTY — data source + input target. opacity-0 (not
          `invisible`) so its input element stays focusable; the translated
          layer's opaque bg covers the raw screen. SAME px-4 as the translated
          column so the native lays out (and self-ellipsizes) at exactly the
          width we render — its compact one-line-per-item menus show 1:1, no
          re-wrapping, no clipping. */}
      <div className="absolute inset-0 px-4 opacity-0">
        <Suspense fallback={null}>
          <ChatTerminal
            key={tabId}
            tabId={tabId}
            taskId={taskId}
            mode="engine"
            hideComposer
            focusNonce={focusNonce}
            onColoredBuffer={setColored}
          />
        </Suspense>
      </div>
      <div className="relative z-10 flex h-full flex-col bg-bg">
        <div className="min-h-0 flex-1">
          <TtyBlocksView blocks={body} sessionId={sessionId} />
        </div>
        <div className="shrink-0 px-4 pb-3 pt-1">
          {footer.length > 0 &&
            (footerInteractive ? (
              // A card only when the engine is WAITING on the user (spinner /
              // slash-menu / question). Passive notices don't earn one.
              <div className="mb-2 rounded-2xl border border-line bg-surface/50 px-4 py-2.5">
                <TtyFooter blocks={footer} sessionId={sessionId} />
              </div>
            ) : (
              // Passive hints (Image in clipboard…) — quiet line above input.
              <div className="mb-1 px-3 text-[11px]">
                <TtyFooter blocks={footer} sessionId={sessionId} />
              </div>
            ))}
          <InputMirror promptText={promptText} sessionId={sessionId} />
          {statusColored.length > 0 && (
            <div className="mt-2 space-y-0.5 px-2">
              {statusColored.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional status rows re-derived per frame
                <StatusLine key={i} line={line} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function ChatShell() {
  const { tasks, activeTaskId, worktreeChanges, engineStates } = useAppState()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const live = useMemo(() => tasks.filter((t) => !t.archived), [tasks])
  const selected =
    live.find((t) => t.id === selectedId) ??
    live.find((t) => t.id === activeTaskId) ??
    live[0] ??
    null

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
                  sessionId={engineStates[selected.id]?.sessionId ?? null}
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
