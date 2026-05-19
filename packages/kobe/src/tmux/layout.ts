/**
 * Pure builder for the tmux step sequence that produces kobe's 5-pane
 * skeleton. Returning typed step records (rather than raw command
 * tuples or live spawn calls) lets the bootstrap resolve each new
 * pane's tmux pane-ID at runtime — pane numeric indices depend on the
 * user's `base-index` / `pane-base-index` settings, so we always
 * target by `%N` IDs captured from `-P -F '#{pane_id}'`.
 *
 * Final layout — left → right, then top → bottom inside each column:
 *
 *   sidebar    (full-height left column)
 *   tab-strip  (single-row band above chat)
 *   chat       (everything below tab-strip in the middle)
 *   files      (top of the right column)
 *   shell      (bottom of the right column)
 *
 * KOB-213 sprint-1: every pane runs an `echo … ; sleep infinity`
 * placeholder. Later sprints replace chat with a native `claude` TUI
 * and the rest with daemon-driven processes.
 */

export type PaneLabel = "sidebar" | "tab-strip" | "chat" | "files" | "shell"

export type LayoutStep =
  | {
      readonly kind: "new-session"
      readonly name: "sidebar"
      readonly sessionName: string
      readonly windowName: string
      readonly command: string
    }
  | {
      readonly kind: "split"
      readonly name: PaneLabel
      readonly targetLabel: PaneLabel
      readonly direction: "h" | "v"
      readonly size: string
      readonly command: string
    }
  | { readonly kind: "resize"; readonly targetLabel: PaneLabel; readonly heightRows: number }
  | { readonly kind: "select"; readonly targetLabel: PaneLabel }

export interface LayoutPlaceholders {
  readonly sidebar: string
  readonly tabStrip: string
  readonly chat: string
  readonly files: string
  readonly shell: string
}

export interface LayoutOptions {
  readonly sessionName: string
  readonly windowName?: string
  readonly placeholders: LayoutPlaceholders
}

export const DEFAULT_PLACEHOLDERS: LayoutPlaceholders = {
  sidebar: "[sidebar] tasks — placeholder (KOB-213)",
  tabStrip: "[tab-strip] tabs — placeholder",
  chat: "[chat] claude TUI — placeholder",
  files: "[files] file tree — placeholder",
  shell: "[shell] terminal — placeholder",
}

/**
 * Wrap a placeholder label in a shell snippet that prints the label
 * once and then blocks forever via `tail -f /dev/null`. `exec` drops
 * the intermediate shell so each pane shows exactly one process.
 *
 * We avoid `sleep infinity` because BSD `sleep` (macOS) only accepts a
 * numeric argument and exits immediately on `infinity` — which would
 * close the pane and destroy the session before bootstrap finishes.
 */
export function placeholderShellCommand(label: string): string {
  const safeLabel = label.replace(/'/g, `'\\''`)
  return `printf '%s\\n' '${safeLabel}'; exec tail -f /dev/null`
}

export function buildLayoutSteps(opts: LayoutOptions): LayoutStep[] {
  const windowName = opts.windowName ?? "kobe"
  const ph = opts.placeholders
  return [
    {
      kind: "new-session",
      name: "sidebar",
      sessionName: opts.sessionName,
      windowName,
      command: placeholderShellCommand(ph.sidebar),
    },
    // Carve the right ~75% out of the sidebar pane. The sidebar keeps
    // the left 25%; the new pane will become the tab-strip (resized
    // down to 1 row below).
    {
      kind: "split",
      name: "tab-strip",
      targetLabel: "sidebar",
      direction: "h",
      size: "75%",
      command: placeholderShellCommand(ph.tabStrip),
    },
    // Peel the right column (files+shell) off the middle band. The
    // new pane takes the rightmost 33% of the current tab-strip pane.
    {
      kind: "split",
      name: "files",
      targetLabel: "tab-strip",
      direction: "h",
      size: "33%",
      command: placeholderShellCommand(ph.files),
    },
    // Drop chat below the tab-strip. New pane gets 99% of the
    // column's height; the tab-strip keeps the rest, then the
    // resize step below clamps it to exactly 1 row.
    {
      kind: "split",
      name: "chat",
      targetLabel: "tab-strip",
      direction: "v",
      size: "99%",
      command: placeholderShellCommand(ph.chat),
    },
    { kind: "resize", targetLabel: "tab-strip", heightRows: 1 },
    // Split the right column vertically. Files keep the top half;
    // new pane (shell) takes the bottom half.
    {
      kind: "split",
      name: "shell",
      targetLabel: "files",
      direction: "v",
      size: "50%",
      command: placeholderShellCommand(ph.shell),
    },
    // Default focus on chat so the user lands where typing matters.
    { kind: "select", targetLabel: "chat" },
  ]
}
