import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { type Accessor, createEffect, createMemo, createSignal, on } from "solid-js"
import { makeDropdownWindow } from "./dropdown-window"
import {
  type MentionContext,
  type MentionMatch,
  filterMentionMatches,
  findMentionContext,
  getWorktreeFiles,
} from "./mention"
import { type PreviewablePathRef, findPreviewablePathRefs } from "./path-preview"

const MENTION_MAX_VISIBLE = 8

export type MentionController = {
  readonly open: Accessor<boolean>
  readonly window: Accessor<{
    readonly items: readonly MentionMatch[]
    readonly start: number
    readonly total: number
  }>
  readonly cursor: Accessor<number>
  readonly pathRefs: Accessor<readonly PreviewablePathRef[]>
  readonly handleKeyDown: (key: KeyEvent) => boolean
}

export function createMentionController(args: {
  readonly worktreePath: Accessor<string | undefined>
  readonly liveBuffer: Accessor<string>
  readonly liveCursor: Accessor<number>
  readonly slashOpen: Accessor<boolean>
  readonly textarea: Accessor<TextareaRenderable | undefined>
}): MentionController {
  const [files, setFiles] = createSignal<readonly string[]>([])
  const [cursor, setCursor] = createSignal(0)
  // Buffer offset of an `@` the user explicitly dismissed via Esc.
  // While the active mention context still resolves to this anchor,
  // suppress the dropdown. Cleared once the cursor leaves the mention
  // region (or another `@` is typed).
  const [dismissedAt, setDismissedAt] = createSignal<number | null>(null)

  // Refetch the worktree file list when the active task's worktree
  // changes. The dropdown opens immediately with whatever is cached
  // (empty on first open per worktree), then reactive setFiles() flips
  // matches in once the list arrives.
  createEffect(
    on(args.worktreePath, (wt) => {
      if (!wt) {
        setFiles([])
        return
      }
      getWorktreeFiles(wt)
        .then(setFiles)
        .catch(() => setFiles([]))
    }),
  )

  const context = createMemo<MentionContext | null>(() => {
    if (!args.worktreePath()) return null
    return findMentionContext(args.liveBuffer(), args.liveCursor())
  })

  // Clear the Esc-dismissed anchor when the cursor leaves its span.
  createEffect(() => {
    const ctx = context()
    const dismissed = dismissedAt()
    if (dismissed === null) return
    if (!ctx || ctx.atPos !== dismissed) setDismissedAt(null)
  })

  const matches = createMemo<readonly MentionMatch[]>(() => {
    const ctx = context()
    if (!ctx) return []
    if (dismissedAt() === ctx.atPos) return []
    return filterMentionMatches(files(), ctx.query, MENTION_MAX_VISIBLE * 4)
  })

  // Slash dropdown wins when both could open — a buffer starting with
  // `/` shouldn't surface a file picker because the user is plainly
  // running a command.
  const open = createMemo(() => !args.slashOpen() && matches().length > 0)

  // Keep cursor in bounds when the match list changes.
  createEffect(() => {
    const len = matches().length
    setCursor((cur) => (len === 0 ? 0 : Math.min(cur, len - 1)))
  })

  const window = createMemo(() => makeDropdownWindow(matches(), cursor(), MENTION_MAX_VISIBLE))

  const pathRefs = createMemo(() => findPreviewablePathRefs(args.liveBuffer(), files()))

  /**
   * Replace the active mention span (`@<query>`) with `@<relPath> `.
   * Uses `setSelection` + `insertText` so the operation participates in
   * undo. Cursor lands one past the trailing space, ready for more
   * typing — matches opcode (`handleFileSelect`) and the image-paste
   * `[Image #N]` placeholder convention.
   */
  function insertSelection(path: string): void {
    const ref = args.textarea()
    const ctx = context()
    if (!ref || !ctx) return
    const currentCursor = ref.cursorOffset
    ref.setSelection(ctx.atPos, currentCursor)
    ref.deleteSelection()
    ref.insertText(`@${path} `)
    setDismissedAt(null)
    setCursor(0)
  }

  /**
   * Mention-dropdown nav. Priority sits above history (so up/down walk
   * the file list instead of recalling prompts). Tab and Enter both
   * insert the highlighted file path; Esc dismisses the dropdown until
   * the cursor leaves the `@` region.
   */
  function handleKeyDown(key: KeyEvent): boolean {
    if (!open()) return false

    if (key.name === "up" && !key.shift && !key.ctrl && !key.meta && !key.super) {
      const len = matches().length
      setCursor((cur) => (cur - 1 + len) % len)
      key.preventDefault()
      return true
    }
    if (key.name === "down" && !key.shift && !key.ctrl && !key.meta && !key.super) {
      const len = matches().length
      setCursor((cur) => (cur + 1) % len)
      key.preventDefault()
      return true
    }
    if ((key.name === "return" || key.name === "tab") && !key.shift && !key.ctrl) {
      const match = matches()[cursor()]
      if (match) {
        insertSelection(match.path)
        key.preventDefault()
        return true
      }
    }
    if (key.name === "escape") {
      const ctx = context()
      if (ctx) setDismissedAt(ctx.atPos)
      key.preventDefault()
      return true
    }

    return false
  }

  return {
    open,
    window,
    cursor,
    pathRefs,
    handleKeyDown,
  }
}
