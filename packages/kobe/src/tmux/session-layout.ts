/**
 * Pure command/layout builders for a task's tmux session — the public entry.
 *
 * The session-build procedure (`tui/panes/terminal/tmux.ts`
 * `ensureSession`) is unavoidably imperative — it spawns `tmux
 * new-session` / `split-window` against a real server. But the
 * *policy* it encodes — pane sizes, which shell command each pane
 * runs, the keep-alive wrapper, the Ops-pane fallback — is pure data
 * + string building. Pulling it out here makes that policy unit
 * testable without a real tmux server — exactly the surface where
 * quoting + targeting bugs only show up at runtime.
 *
 * Layering (each internal to `src/tmux/` — import THIS module from outside):
 *   launch-line.ts    keep-alive wrapper, repo-init watchdog, engine launch line
 *   pane-commands.ts  Tasks/Ops/home/preview/update/URL pane + window commands
 * plus the role/option constants and layout geometry defined below.
 * Everything in this file is pure: same inputs → same strings, no IO.
 */

import { quoteShellArg, quoteShellArgv } from "@/lib/shell-command"

/**
 * Far-left Tasks pane width in CELLS — FIXED, not a % of the window
 *. A %-split drifted: the pane's absolute width changed with the
 * terminal size, between chat-tab windows, and across engine (claude/codex)
 * rebuilds (tmux re-lays-out %-panes on those events). Direct-tmux mode
 * makes this pane the primary navigator, not a tiny preview rail, so 32 cells
 * is the convention width that fits Working/Archives, task titles, and the
 * shortcut legend without clipped text.
 */
export const TASKS_PANE_WIDTH = 32
export const TASKS_PANE_ROLE = "tasks"
export const ENGINE_PANE_ROLE = "claude"
export const OPS_PANE_ROLE = "ops"
export const SHELL_PANE_ROLE = "shell"
export const WORKSPACE_AUX_PANE_ROLE = "workspace_aux"
export const WORKSPACE_SPLIT_MAX_PANES = 4
export const HIDDEN_TERMINAL_PANE_OPTION = "@kobe_hidden_shell_pane"
export const HIDDEN_TASKS_PANE_OPTION = "@kobe_hidden_tasks_pane"
/**
 * While zen mode is active this window option holds the comma-joined list of
 * pane roles zen hid (`ops`, `terminal`, `tasks`), so leaving zen restores
 * exactly those panes and nothing the user had already collapsed themselves.
 */
export const ZEN_HIDDEN_PANES_OPTION = "@kobe_zen_panes"

/**
 * Session-scoped flag marking zen mode as ON for the WHOLE session (every
 * ChatTab), not just one window. When set, the zen toggle collapses/expands
 * all engine ChatTabs at once, and a freshly created ChatTab opens collapsed
 * too — so zen survives tab switches and new tabs. Per-window restore detail
 * still lives in {@link ZEN_HIDDEN_PANES_OPTION} on each window.
 */
export const ZEN_SESSION_OPTION = "@kobe_zen"

/** Hidden helper session that holds panes broken out of one task session. */
export function hiddenTerminalSessionName(session: string): string {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, "")
  return `kobe-hidden-${safe || "session"}`
}

/** Stable hidden-window slot for a ChatTab's active window id. */
export function hiddenTerminalWindowIndex(windowId: string): number {
  const n = Number.parseInt(windowId.replace(/^@/, ""), 10)
  return Number.isFinite(n) && n >= 0 ? 1000 + n : 1000
}

/**
 * Server-scoped tmux user option holding the user's GLOBAL Tasks-rail width in
 * cells. One value shared by every task session, so the rail stays the same
 * width across task switches: the user drags it once and it sticks everywhere
 * (captured on switch-away, applied on every session build/reuse). Unset → the
 * `TASKS_PANE_WIDTH` convention default.
 */
export const TASKS_WIDTH_OPTION = "@kobe_tasks_width"

/** Sane bounds for a user-chosen Tasks-rail width (cells). */
export const TASKS_PANE_WIDTH_MIN = 16
export const TASKS_PANE_WIDTH_MAX = 120

/** Clamp a candidate Tasks-rail width to the sane range; default on garbage. */
export function clampTasksPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return TASKS_PANE_WIDTH
  return Math.max(TASKS_PANE_WIDTH_MIN, Math.min(TASKS_PANE_WIDTH_MAX, Math.round(width)))
}

/** Left (claude) pane width as a % of the window. */
export const CLAUDE_PANE_PERCENT = 60

/** Upper-right (Ops) pane height as a % of the right column. */
export const OPS_PANE_PERCENT = 50

/**
 * Server-scoped tmux user options holding the user's GLOBAL right-column
 * geometry, each a percentage OF THE WINDOW (the unit `resize-pane -x/-y N%`
 * uses), shared by every task session so the right column looks the same in
 * every task. Unset → the default split the layout builds, so a user who never
 * dragged the right column keeps today's behaviour untouched.
 *
 * - {@link RIGHT_COLUMN_WIDTH_OPTION}: the right column (Ops file-tree + the
 *   terminal below it) width as a % of the window.
 * - {@link OPS_HEIGHT_OPTION}: the Ops (file-tree) pane height as a % of the
 *   window, i.e. where the file-tree / terminal split sits.
 */
export const RIGHT_COLUMN_WIDTH_OPTION = "@kobe_right_width_pct"
export const OPS_HEIGHT_OPTION = "@kobe_ops_height_pct"

/** Bounds for a pane split percentage — keeps neither side from collapsing. */
export const PANE_PERCENT_MIN = 10
export const PANE_PERCENT_MAX = 90

/** Clamp a split percentage to the sane range; `null` on garbage (skip it). */
export function clampPanePercent(percent: number): number | null {
  if (!Number.isFinite(percent)) return null
  return Math.max(PANE_PERCENT_MIN, Math.min(PANE_PERCENT_MAX, Math.round(percent)))
}

/**
 * The user's effective workspace geometry, resolved from the global `@kobe_*`
 * options. The single owner of "how wide should the rail / right column be" —
 * every reader (`buildPanesAround`, `healWorkspaceLayout`, the layout-action
 * toggles, `globalTasksPaneWidth`) goes through {@link resolveLayoutGeometry}
 * instead of re-parsing + re-clamping + re-defaulting the same three options.
 *
 * Two consumption modes are both served:
 *  - the concrete `*Pct` / `tasksWidth` numbers always carry a default, for the
 *    toggle math that needs a value even when the user never dragged;
 *  - `rightColumnResizeArgs` is per-axis and EMPTY when the user never dragged,
 *    so the build/heal path leaves the default split untouched (no override).
 */
export interface LayoutGeometry {
  /** Tasks-rail width in cells (clamped; default `TASKS_PANE_WIDTH`). */
  readonly tasksWidth: number
  /** Right-column width as a % of the window (clamped; default `100 - CLAUDE_PANE_PERCENT`). */
  readonly rightColumnWidthPct: number
  /** Ops (file-tree) height as a % of the window (clamped; default `OPS_PANE_PERCENT`). */
  readonly opsHeightPct: number
  /** `resize-pane -x/-y N%` args for the Ops pane — per-axis, EMPTY when the user
   *  never dragged the right column (so build/heal keep the default split). */
  readonly rightColumnResizeArgs: readonly string[]
}

/** The three server options the geometry resolver reads — one IO spawn covers all. */
export const LAYOUT_GEOMETRY_OPTIONS = [TASKS_WIDTH_OPTION, RIGHT_COLUMN_WIDTH_OPTION, OPS_HEIGHT_OPTION] as const

/**
 * Resolve {@link LayoutGeometry} from a raw `@kobe_*` option map (pure — no IO,
 * so it's unit-tested). `opts` is what `getServerOptions` returns; the IO
 * wrapper `readLayoutGeometry` (tmux/client) feeds it.
 */
export function resolveLayoutGeometry(opts: Record<string, string | undefined>): LayoutGeometry {
  const rawWidth = Number.parseInt(opts[TASKS_WIDTH_OPTION] ?? "", 10)
  const tasksWidth = Number.isFinite(rawWidth) && rawWidth > 0 ? clampTasksPaneWidth(rawWidth) : TASKS_PANE_WIDTH
  const widthPct = clampPanePercent(Number.parseInt(opts[RIGHT_COLUMN_WIDTH_OPTION] ?? "", 10))
  const heightPct = clampPanePercent(Number.parseInt(opts[OPS_HEIGHT_OPTION] ?? "", 10))
  const rightColumnResizeArgs: string[] = []
  if (widthPct !== null) rightColumnResizeArgs.push("-x", `${widthPct}%`)
  if (heightPct !== null) rightColumnResizeArgs.push("-y", `${heightPct}%`)
  return {
    tasksWidth,
    rightColumnWidthPct: widthPct ?? 100 - CLAUDE_PANE_PERCENT,
    opsHeightPct: heightPct ?? OPS_PANE_PERCENT,
    rightColumnResizeArgs,
  }
}

/**
 * Quote `s` for safe inclusion inside a single-line `sh -c` command.
 * tmux runs each pane command via `sh -c`, and we build that command
 * string ourselves, so any path with a space or quote needs POSIX
 * single-quote escaping (`'` → `'\''`).
 */
export function shellQuote(s: string): string {
  return quoteShellArg(s)
}

/** Shell-quote each argv element and join — a safe command line. */
export function shellQuoteArgv(argv: readonly string[]): string {
  return quoteShellArgv(argv)
}

export {
  type EngineInitLaunch,
  REPO_INIT_TIMEOUT_MAX_SECONDS,
  REPO_INIT_TIMEOUT_MIN_SECONDS,
  REPO_INIT_TIMEOUT_SECONDS,
  SIGINT_GUARD,
  engineLaunchLine,
  engineTabExitCleanup,
  historyPaneKeepAlive,
  keepAlive,
  resolveRepoInitTimeoutSeconds,
} from "./launch-line"
export {
  fallbackOpsScript,
  homeWelcomeCommand,
  openUrlCommand,
  opsPaneCommand,
  previewWindowCommand,
  tasksPaneCommand,
  updatePageCommand,
} from "./pane-commands"
