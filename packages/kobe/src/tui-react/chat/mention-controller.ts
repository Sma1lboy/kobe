/**
 * React `@`-mention controller — the `src/tui/chat/composer/mention-controller.ts`
 * counterpart (issue #15 G3). All mention SEMANTICS (context detection,
 * ranking, file-list cache, dropdown windowing, path-chip detection) are the
 * shared framework-free modules; this hook owns only the React reactivity.
 *
 * Latency note: the derived values are `useMemo`s keyed on the live buffer /
 * cursor the composer already re-renders for on each keystroke, and
 * `handleKeyDown` reads state through a render-refreshed ref so its identity
 * stays stable (no per-key closure churn in the textarea props).
 */

import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { useEffect, useMemo, useRef, useState } from "react"
import { type DropdownWindow, makeDropdownWindow } from "../../tui/chat/composer/dropdown-window"
import { isPlainAutocompleteTabKey } from "../../tui/chat/composer/keys"
import {
  type MentionContext,
  type MentionMatch,
  filterMentionMatches,
  findMentionContext,
  getWorktreeFiles,
} from "../../tui/chat/composer/mention"
import { type PreviewablePathRef, findPreviewablePathRefs } from "../../tui/chat/composer/path-preview"

const MENTION_MAX_VISIBLE = 8

export type MentionController = {
  readonly open: boolean
  readonly window: DropdownWindow<MentionMatch>
  readonly cursor: number
  readonly pathRefs: readonly PreviewablePathRef[]
  readonly handleKeyDown: (key: KeyEvent) => boolean
}

export function useMentionController(args: {
  readonly worktreePath: string | undefined
  readonly liveBuffer: string
  readonly liveCursor: number
  readonly slashOpen: boolean
  readonly textarea: () => TextareaRenderable | undefined
}): MentionController {
  const [files, setFiles] = useState<readonly string[]>([])
  const [cursor, setCursor] = useState(0)
  // Buffer offset of an `@` the user explicitly dismissed via Esc. While the
  // active mention context still resolves to this anchor, suppress the
  // dropdown. Cleared once the cursor leaves the mention region.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)

  // Refetch the worktree file list when the active task's worktree changes.
  // Canon async shape (see tui-react/history/host.tsx): dependency-keyed
  // effect, disposed-flag cancellation, failures collapse to empty.
  useEffect(() => {
    if (!args.worktreePath) {
      setFiles([])
      return
    }
    let disposed = false
    getWorktreeFiles(args.worktreePath)
      .then((list) => {
        if (!disposed) setFiles(list)
      })
      .catch(() => {
        if (!disposed) setFiles([])
      })
    return () => {
      disposed = true
    }
  }, [args.worktreePath])

  const context = useMemo<MentionContext | null>(() => {
    if (!args.worktreePath) return null
    return findMentionContext(args.liveBuffer, args.liveCursor)
  }, [args.worktreePath, args.liveBuffer, args.liveCursor])

  // Clear the Esc-dismissed anchor when the cursor leaves its span.
  useEffect(() => {
    if (dismissedAt === null) return
    if (!context || context.atPos !== dismissedAt) setDismissedAt(null)
  }, [context, dismissedAt])

  const matches = useMemo<readonly MentionMatch[]>(() => {
    if (!context) return []
    if (dismissedAt === context.atPos) return []
    return filterMentionMatches(files, context.query, MENTION_MAX_VISIBLE * 4)
  }, [context, dismissedAt, files])

  // Slash dropdown wins when both could open — a buffer starting with `/`
  // shouldn't surface a file picker because the user is plainly running a
  // command.
  const open = !args.slashOpen && matches.length > 0

  // Keep cursor in bounds when the match list changes.
  useEffect(() => {
    const len = matches.length
    setCursor((cur) => (len === 0 ? 0 : Math.min(cur, len - 1)))
  }, [matches.length])

  const window = useMemo(() => makeDropdownWindow(matches, cursor, MENTION_MAX_VISIBLE), [matches, cursor])

  const pathRefs = useMemo(() => findPreviewablePathRefs(args.liveBuffer, files), [args.liveBuffer, files])

  // Stable key handler over a render-refreshed state ref (useBindings pattern).
  const stateRef = useRef({ open, matches, cursor, context })
  stateRef.current = { open, matches, cursor, context }
  const handlersRef = useRef<((key: KeyEvent) => boolean) | null>(null)
  if (handlersRef.current === null) {
    /**
     * Replace the active mention span (`@<query>`) with `@<relPath> `.
     * Uses `setSelection` + `insertText` so the operation participates in
     * undo. Cursor lands one past the trailing space, ready for more typing.
     */
    const insertSelection = (path: string): void => {
      const ref = args.textarea()
      const ctx = stateRef.current.context
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
    handlersRef.current = (key: KeyEvent): boolean => {
      const s = stateRef.current
      if (!s.open) return false

      if (key.name === "up" && !key.shift && !key.ctrl && !key.meta && !key.super) {
        const len = s.matches.length
        setCursor((cur) => (cur - 1 + len) % len)
        key.preventDefault()
        return true
      }
      if (key.name === "down" && !key.shift && !key.ctrl && !key.meta && !key.super) {
        const len = s.matches.length
        setCursor((cur) => (cur + 1) % len)
        key.preventDefault()
        return true
      }
      if ((key.name === "return" && !key.shift && !key.ctrl) || isPlainAutocompleteTabKey(key)) {
        const match = s.matches[s.cursor]
        if (match) {
          insertSelection(match.path)
          key.preventDefault()
          return true
        }
      }
      if (key.name === "escape") {
        if (s.context) setDismissedAt(s.context.atPos)
        key.preventDefault()
        return true
      }

      return false
    }
  }

  return { open, window, cursor, pathRefs, handleKeyDown: handlersRef.current }
}
