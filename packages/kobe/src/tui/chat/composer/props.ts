import type { PermissionMode } from "@/types/engine"
import type { ComposerQueuedItem } from "./queue-item"

/**
 * Structural twin of Solid's `Accessor<T>` so this props contract stays
 * framework-free (issue #15 G3): the Solid composer passes signal getters,
 * the React composer passes plain closures over its latest render.
 */
export type Accessor<T> = () => T

/**
 * Slash entry rendered in the composer's `/` dropdown. `SlashEntry`
 * used to live in the (deleted) command-palette context; the shape is
 * inlined here now that the composer is its only consumer. The
 * optional `source` discriminator renders a muted `user` tag for
 * entries from the user's own `.claude/{commands,skills}/` and leaves
 * the bundled claude-code surface unmarked.
 */
export type ComposerSlashEntry = {
  display: string
  description?: string
  aliases?: string[]
  onSelect: () => void
  readonly source?: "builtin" | "user"
}

export interface ComposerProps {
  /** Current draft text. Controlled by the parent for clear-on-submit. */
  draft: string
  /** Called on every textarea content change. Parent persists the new value. */
  onDraftChange: (value: string) => void
  /** True between user submit and `done`/`error`. Drives prefix + placeholder. */
  isStreaming: boolean
  /** True when a task is selected. False renders the no-task fallback. */
  hasTask: boolean
  /**
   * Optional override for the no-task fallback message. Set this when
   * `hasTask` is false because the active task is in a terminal state
   * (e.g. canceled) rather than because nothing's selected — the user
   * sees a different hint and the textarea stays hidden.
   */
  noTaskMessage?: string
  /**
   * Called on enter with the trimmed text. Empty string = empty-composer enter.
   *
   * `mode` describes the submission intent — `'auto'` (default) lets
   * the parent decide based on streaming state (run-now when idle,
   * queue when streaming); `'steer'` requests an interrupt-then-run
   * even mid-stream. The chat shell maps the key chord `ctrl+enter`
   * to mode='steer' and plain enter to mode='auto'.
   */
  onSubmit: (trimmedText: string, mode?: "auto" | "steer") => void

  // ----- W4.C extensions (all optional; parent doesn't need to set) -----

  /**
   * Stable string used to scope prompt history. In production this is
   * the active task id — task ids persist across kobe restarts (they
   * live in `~/.kobe/tasks.json`), so the same task's ↑↓ walks past
   * sessions' prompts after a reboot (Claude Code parity, per-project
   * filtered there, per-task here because kobe has a task model).
   * Defaults to the sentinel `"global"` when omitted; callers that
   * pass an ephemeral key (e.g. a chat-tab id) get a working but
   * session-only history ring with no cross-restart persistence.
   */
  historyKey?: string
  /**
   * When true, the composer's accent rail picks up `theme.primary`
   * instead of `theme.border`. Optional: callers that don't thread
   * focus get the unfocused (idle) styling.
   */
  focused?: Accessor<boolean>
  /**
   * Optional model label rendered on the right side of the inline
   * footer (e.g. `"Claude Sonnet 4.6"`). Falls back to the literal
   * `claude-code` when omitted.
   */
  modelLabel?: Accessor<string>
  /** Engine-owned chat input placeholder, e.g. "Ask Claude…" or "Ask Codex…". */
  inputPlaceholder?: Accessor<string>
  /**
   * Reactive slash-command list (typically `useCommandSlashes()`). When
   * supplied AND the buffer starts with `/`, the composer renders a
   * filtered dropdown above the textarea; up/down navigate, enter runs
   * the highlighted entry, esc dismisses. Entries may carry an optional
   * `source: "user" | "builtin"` (see {@link ComposerSlashEntry}); when
   * present, user-defined entries render with a muted source tag in
   * the dropdown so the user can tell their own commands apart from the
   * bundled claude-code set at a glance.
   */
  slashes?: Accessor<readonly ComposerSlashEntry[]>
  /**
   * Reactive accessor for the active task's tool-permission mode.
   * When undefined, treated as `"default"` for display. The composer
   * renders an indicator in its inline footer ("⏵ accept edits" /
   * "📋 plan" / etc.) and shift+tab cycles via {@link onCyclePermissionMode}.
   */
  permissionMode?: Accessor<PermissionMode | undefined>
  /** Engine-owned label for the active permission mode. */
  permissionModeLabel?: Accessor<string>
  /**
   * Called when the user presses shift+tab in the composer. The parent
   * computes the next mode and persists it; we just emit the request.
   * Omit to disable shift+tab cycling.
   */
  onCyclePermissionMode?: () => void
  /**
   * Called when the user clicks the model label in the inline footer.
   * Parent typically opens a picker dialog and writes the chosen
   * model back via the orchestrator. Omit to make the label inert.
   */
  onChooseModel?: () => void
  /**
   * Active task's worktree path. Gates the `@`-mention file picker —
   * without it we have no project root to scope the file list to, so
   * `@` falls through as literal text (matches opcode's
   * `if (projectPath?.trim() ...)` guard in FloatingPromptInput.tsx).
   * Accessor so task switches re-trigger the file-list fetch.
   */
  worktreePath?: Accessor<string | undefined>
  /**
   * Mid-stream queued items (FIFO, head fires next). Rendered as a
   * muted list inside the composer rail, immediately above the textarea
   * row, so the queue shares the same bordered block as the input it
   * will feed. Empty list = nothing renders.
   *
   * Discriminated by `kind`: prompt items show plain text, bash items
   * (Claude-Code `!cmd` parity, queued during streaming) render with a
   * leading `(bash)` label in theme.warning so the user can tell at a
   * glance which are queued shell commands vs queued model prompts.
   */
  queue?: Accessor<readonly ComposerQueuedItem[]>
  /**
   * Whether the active tab's queue auto-drain is paused. When true the
   * queue panel surfaces a "resume" affordance and the parent skips
   * draining queued items as turns end.
   */
  queuePaused?: Accessor<boolean>
  /** Toggle the queue-paused flag (pause/resume button). */
  onToggleQueuePause?: () => void
  /** Drop a queued prompt by id (cancel button). */
  onCancelQueued?: (id: string) => void
  /**
   * "Send now" / retrigger — interrupt the in-flight turn and dispatch
   * this queued prompt immediately. Parent removes it from the queue
   * and routes through the steer path.
   */
  onSendQueuedNow?: (id: string) => void

  /**
   * Submit a `!shell` command (Claude-Code-style bash mode). Fires on
   * enter when the buffer starts with `!`; the composer strips the
   * prefix before calling. Parent runs the command locally (not via
   * the engine), streams output into a bash row, and stashes the
   * interaction so the next regular submit prepends it as XML
   * context. Omit to disable bash mode for this composer instance.
   */
  onBashCommand?: (command: string) => void
  /**
   * Open a worktree-relative file path in the workspace preview tab.
   * Composer renders detected paths from the textarea buffer as
   * clickable chips when this is supplied.
   */
  onOpenFilePath?: (relPath: string) => void
  /**
   * Begin editing a queued prompt: parent loads the entry's text into
   * the composer draft and the next submit replaces the entry in
   * place rather than dispatching a fresh prompt. Wired to the
   * `[edit]` button and the queue row's clickable text body. Bash
   * queue entries are intentionally not editable; the parent gates
   * this affordance off for them.
   */
  onEditQueued?: (id: string) => void
  /**
   * Id of the queued prompt currently being edited (parent-owned).
   * The matching row tints its leading `○` marker in `theme.primary`
   * so the user can tell which entry the composer is targeting.
   * `null` / undefined when no row is being edited.
   */
  editingQueueId?: Accessor<string | null>
  /**
   * Maps a history key (typically a chat tab id, occasionally a task
   * id, or the literal `"global"`) to a human-readable label. Used by
   * the Ctrl+R cross-task history palette (KOB-154) to show which task
   * each remembered prompt came from. `undefined` return falls back to
   * showing no task label. Omit the prop entirely to ship a composer
   * without the palette (the Ctrl+R chord becomes inert).
   */
  taskLabelForHistoryKey?: (historyKey: string) => string | undefined
  /**
   * Absolute path of the active task's repo root — the worktree's
   * parent project, NOT the worktree itself. Used as the `project`
   * field when persisting submitted prompts to disk (KOB-157), so a
   * later session can filter palette rows by project. `undefined`
   * persists under the global bucket.
   */
  currentProjectRoot?: Accessor<string | undefined>
}
