/** @jsxImportSource @opentui/react */
/**
 * React multi-line chat composer — the `src/tui/chat/Composer.tsx`
 * counterpart (issue #15 G3). Same contract: the textarea is the source of
 * truth for the buffer, the parent stays informed via `onDraftChange`, and
 * ALL input semantics (bash-mode toggle, slash dropdown, `@` mentions,
 * prompt history, image paste, ctrl+enter steer, ctrl+r palette) live in the
 * shared framework-free `composer/*` modules — this file owns only the React
 * reactivity that feeds them.
 *
 * Input-latency notes (per-keystroke hot path):
 *   - The textarea renderable owns typing; React re-renders only on the
 *     `liveBuffer` mirror update (needed to drive the dropdown filters).
 *   - Derived lists (slash matches, mention matches, dropdown windows) are
 *     `useMemo`s keyed on that mirror — nothing re-filters unless the buffer
 *     actually changed.
 *   - The key router reads state through plain closures over the CURRENT
 *     render (recreated per render, same as every inline handler in this
 *     tree); the heavy work behind those closures is all memoized.
 */

import type { TextareaRenderable } from "@opentui/core"
import { useEffect, useMemo, useRef, useState } from "react"
import { makeDropdownWindow } from "../../tui/chat/composer/dropdown-window"
import { getHistory } from "../../tui/chat/composer/history"
import { PromptHistoryNavigator } from "../../tui/chat/composer/history-nav"
import { createImageAttach } from "../../tui/chat/composer/image-attach"
import { ImagePasteRegistry } from "../../tui/chat/composer/image-paste"
import { createKeyRouter } from "../../tui/chat/composer/key-router"
import type { ComposerProps, ComposerSlashEntry } from "../../tui/chat/composer/props"
import { useFocus } from "../context/focus"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { type ComposerModeTone, ComposerView } from "./composer-view"
import { HistoryPalette } from "./history-palette"
import { useMentionController } from "./mention-controller"

export type { ComposerProps, ComposerSlashEntry } from "../../tui/chat/composer/props"

const NO_SLASHES: readonly ComposerSlashEntry[] = []

// Claude Code-style dropdown windowing: keep roughly eight rows visible and
// scroll the window around the cursor.
const SLASH_MAX_VISIBLE = 8

export function Composer(props: ComposerProps) {
  const { theme } = useTheme()
  const focusCtx = useFocus()
  const dialog = useDialog()

  // Imperative ref to the textarea renderable (set once opentui mounts the
  // node): draft sync, cursor reads for history nav, setText/focus calls.
  const textareaRef = useRef<TextareaRenderable | undefined>(undefined)

  // Latest-props ref so once-created helpers (history navigator, palette
  // seam) never read stale closures.
  const propsRef = useRef(props)
  propsRef.current = props

  // Transient "no image on clipboard" / paste-failure hint (ctrl+v path);
  // cleared by the next keystroke.
  const [pasteHint, setPasteHint] = useState<string | null>(null)
  // Live draft mirror driving the slash/mention filters, plus its cursor
  // companion (mention detection is cursor-positional).
  const [liveBuffer, setLiveBuffer] = useState(props.draft ?? "")
  const [liveCursor, setLiveCursor] = useState(props.draft?.length ?? 0)
  // Bash-mode state — typing `!` on an empty buffer SWITCHES MODES instead
  // of inserting the character (claude-code parity); the buffer holds the
  // command verbatim and the glyph carries the mode.
  const [bashMode, setBashMode] = useState(false)
  const [slashCursor, setSlashCursor] = useState(0)

  const bashAvailable = (): boolean => propsRef.current.onBashCommand != null

  /**
   * Update the textarea's text imperatively — `setText` (clean slate,
   * clears undo) for history recall and clear-after-submit, cursor at the
   * end so the user keeps typing immediately. The renderable's own
   * content-change event mirrors the new text back into `liveBuffer`.
   */
  function setBuffer(text: string): void {
    const ref = textareaRef.current
    if (!ref) return
    if (ref.plainText === text) return
    ref.setText(text)
    ref.cursorOffset = text.length
  }

  /**
   * Shared recall dispatch for up-arrow history and the ctrl+r palette:
   * a `!`-prefixed stored entry re-enters bash mode with the `!` stripped
   * (KOB-151), anything else lands as a plain prompt.
   */
  function applyHistoryRecall(recalled: string): void {
    if (recalled.startsWith("!") && bashAvailable()) {
      setBuffer(recalled.slice(1))
      setBashMode(true)
      return
    }
    setBuffer(recalled)
    setBashMode(false)
  }
  const recallRef = useRef(applyHistoryRecall)
  recallRef.current = applyHistoryRecall

  // History cursor + per-composer image registry — one instance each for
  // the component's lifetime, reading live state through refs.
  const bashModeRef = useRef(bashMode)
  bashModeRef.current = bashMode
  const historyNav = useMemo(
    () =>
      new PromptHistoryNavigator(
        () => getHistory(propsRef.current.historyKey ?? "global"),
        () => {
          const text = textareaRef.current?.plainText ?? ""
          return bashModeRef.current ? `!${text}` : text
        },
        (recalled) => recallRef.current(recalled),
      ),
    [],
  )
  const imageRegistry = useMemo(() => new ImagePasteRegistry(), [])

  // Slash dropdown: open while the buffer is a bare `/command` prefix.
  const slashEntries = props.slashes?.() ?? NO_SLASHES
  const slashOpen = props.slashes != null && liveBuffer.startsWith("/") && !/\s/.test(liveBuffer)
  const slashMatches = useMemo<readonly ComposerSlashEntry[]>(() => {
    if (!slashOpen) return NO_SLASHES
    const query = liveBuffer.toLowerCase()
    return slashEntries.filter((entry) => {
      if (entry.display.toLowerCase().startsWith(query)) return true
      return entry.aliases?.some((a) => a.toLowerCase().startsWith(query)) ?? false
    })
  }, [slashOpen, slashEntries, liveBuffer])

  // Keep cursor in bounds when the match list changes.
  useEffect(() => {
    const len = slashMatches.length
    setSlashCursor((cur) => (len === 0 ? 0 : Math.min(cur, len - 1)))
  }, [slashMatches.length])

  const slashWindow = useMemo(
    () => makeDropdownWindow(slashMatches, slashCursor, SLASH_MAX_VISIBLE),
    [slashMatches, slashCursor],
  )

  const mention = useMentionController({
    worktreePath: props.worktreePath?.(),
    liveBuffer,
    liveCursor,
    slashOpen,
    textarea: () => textareaRef.current,
  })
  const previewablePathRefs = props.onOpenFilePath ? mention.pathRefs : []

  // Mirror the workspace pane's focus state onto the textarea, re-asserting
  // on `refocusTick` so a same-pane refocus (tab-chip click) restores native
  // focus even when the pane state didn't change.
  const focusedNow = props.focused?.() ?? false
  useEffect(() => {
    // Dependency-only invalidation key (history-host canon): a same-pane
    // refocus bumps the tick without changing `focusedNow`.
    void focusCtx.refocusTick
    const ref = textareaRef.current
    if (!ref) return
    if (focusedNow) ref.focus()
    else ref.blur()
  }, [focusedNow, focusCtx.refocusTick])

  // Sync parent's `draft` onto the textarea when it diverges (the common
  // case: clear-after-submit round-trip).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the parent draft only — setBuffer is an imperative helper over a ref.
  useEffect(() => {
    const ref = textareaRef.current
    if (ref && ref.plainText !== props.draft) setBuffer(props.draft)
    setLiveBuffer(props.draft)
  }, [props.draft])

  // Reset history nav + image numbering when the active history key changes
  // (task switch): index 4 of the old key is meaningless for the new one.
  useEffect(() => {
    // Dependency-only invalidation key: the reset fires on key CHANGE.
    void props.historyKey
    historyNav.reset()
    imageRegistry.clear()
    setPasteHint(null)
  }, [props.historyKey, historyNav, imageRegistry])

  // ------- Event handlers -------

  const { handlePaste, tryAttachClipboardImage } = useMemo(
    () =>
      createImageAttach({
        getTextarea: () => textareaRef.current,
        imageRegistry,
        setPasteHint,
      }),
    [imageRegistry],
  )

  // Recreated per render on purpose: its closures read THIS render's state,
  // matching every other inline handler; all list work behind it is memoized.
  const { handleKeyDown, handleSubmit, handleContentChange } = createKeyRouter({
    props,
    // Framework seam: the router is framework-free; only the show-palette
    // capability crosses over (the React dialog stack stays here).
    showHistoryPalette: (opts) => HistoryPalette.show(dialog, opts),
    getTextarea: () => textareaRef.current,
    bashMode: () => bashMode,
    setBashMode,
    bashAvailable,
    liveBuffer: () => liveBuffer,
    setLiveBuffer,
    setLiveCursor,
    setBuffer,
    slashOpen: () => slashOpen,
    slashMatches: () => slashMatches,
    slashCursor: () => slashCursor,
    setSlashCursor,
    mention,
    historyNav,
    imageRegistry,
    pasteHint: () => pasteHint,
    setPasteHint,
    applyHistoryRecall,
    tryAttachClipboardImage,
  })

  // Drop the ref on unmount so straggling effects don't poke a destroyed
  // renderable.
  useEffect(
    () => () => {
      textareaRef.current = undefined
    },
    [],
  )

  // Footer copy: bash mode dominates (the user must SEE the mode mid-turn),
  // then the streaming queue/steer hint; paste feedback wins over both
  // because it is transient state the user just triggered.
  const streamingNotice = (): string => {
    if (!props.hasTask) return ""
    if (bashMode) return props.isStreaming ? "bash mode · enter to queue" : "bash mode · enter to run"
    if (props.isStreaming) return "enter queue · ctrl+enter steer"
    return ""
  }
  const footerHint = pasteHint ?? streamingNotice()
  const modelLabel = props.modelLabel?.() ?? ""
  const permissionModeLabel =
    props.permissionModeLabel?.() ?? (props.permissionMode?.() === "plan" ? "plan mode" : "default")

  // Mode indicator: plain text labels, no emoji glyphs; plan mode must be
  // unmistakable so the user doesn't submit a destructive prompt mid-plan.
  const modeBadge: { label: string; tone: ComposerModeTone } | null =
    props.permissionMode?.() === "plan" ? { label: permissionModeLabel, tone: "primary" } : null
  const toneColor = (tone: ComposerModeTone) => {
    switch (tone) {
      case "accent":
        return theme.accent
      case "primary":
        return theme.primary
      case "warning":
        return theme.warning
      default:
        return theme.textMuted
    }
  }
  // Rail color priority: non-default mode > focused > idle border — the mode
  // signal persists even when focus moves to a sibling pane.
  const railColor = modeBadge ? toneColor(modeBadge.tone) : focusedNow ? theme.primary : theme.border

  function handleTextareaMount(r: TextareaRenderable | null): void {
    if (!r) {
      textareaRef.current = undefined
      return
    }
    textareaRef.current = r
    if (propsRef.current.draft) r.setText(propsRef.current.draft)
    r.onPaste = handlePaste
    if (propsRef.current.focused?.()) r.focus()
  }

  return (
    <ComposerView
      hasTask={props.hasTask}
      noTaskMessage={props.noTaskMessage}
      isStreaming={props.isStreaming}
      inputPlaceholder={props.inputPlaceholder?.()}
      bashMode={bashMode}
      railColor={railColor}
      footerHint={footerHint}
      modelLabel={modelLabel}
      permissionModeLabel={permissionModeLabel}
      modeBadge={modeBadge}
      toneColor={toneColor}
      mentionOpen={mention.open}
      mentionWindow={mention.window}
      mentionCursor={mention.cursor}
      slashOpen={slashOpen}
      slashMatchesLength={slashMatches.length}
      slashWindow={slashWindow}
      slashCursor={slashCursor}
      queue={props.queue?.() ?? []}
      queuePaused={props.queuePaused?.() ?? false}
      onToggleQueuePause={props.onToggleQueuePause}
      editingQueueId={props.editingQueueId?.() ?? null}
      onEditQueued={props.onEditQueued}
      onSendQueuedNow={props.onSendQueuedNow}
      onCancelQueued={props.onCancelQueued}
      pathRefs={previewablePathRefs}
      onOpenFilePath={props.onOpenFilePath}
      onCyclePermissionMode={props.onCyclePermissionMode}
      onChooseModel={props.onChooseModel}
      onTextareaMount={handleTextareaMount}
      onContentChange={handleContentChange}
      onKeyDown={handleKeyDown}
      onSubmit={() => handleSubmit("auto")}
    />
  )
}
