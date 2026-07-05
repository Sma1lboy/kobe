import type { DialogContext } from "@/tui/ui/dialog"
import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import type { Accessor, Setter } from "solid-js"
import { isCursorAtFirstLine, isCursorAtLastLine } from "./cursor"
import { pushHistory } from "./history"
import type { PromptHistoryNavigator } from "./history-nav"
import { HistoryPalette } from "./history-palette-controller"
import type { ImagePasteRegistry } from "./image-paste"
import { deleteImageTokenBackward, deleteImageTokenForward } from "./image-token-delete"
import { isPermissionModeCycleKey, isPlainAutocompleteTabKey } from "./keys"
import type { MentionController } from "./mention-controller"
import type { ComposerProps, ComposerSlashEntry } from "./props"

/**
 * Input-event glue extracted from Composer: the raw-key router
 * ({@link handleKeyDown}), the submit path ({@link handleSubmit}), and
 * the content-change mirror ({@link handleContentChange}). Kept in one
 * factory because they share the same reactive dependency bag and the
 * router calls submit directly (ctrl+enter steer).
 */
export function createKeyRouter(deps: {
  readonly props: ComposerProps
  readonly dialog: DialogContext
  readonly getTextarea: () => TextareaRenderable | undefined
  readonly bashMode: Accessor<boolean>
  readonly setBashMode: Setter<boolean>
  readonly bashAvailable: () => boolean
  readonly liveBuffer: Accessor<string>
  readonly setLiveBuffer: Setter<string>
  readonly setLiveCursor: Setter<number>
  readonly setBuffer: (text: string) => void
  readonly slashOpen: Accessor<boolean>
  readonly slashMatches: Accessor<readonly ComposerSlashEntry[]>
  readonly slashCursor: Accessor<number>
  readonly setSlashCursor: Setter<number>
  readonly mention: MentionController
  readonly historyNav: PromptHistoryNavigator
  readonly imageRegistry: ImagePasteRegistry
  readonly pasteHint: Accessor<string | null>
  readonly setPasteHint: Setter<string | null>
  readonly applyHistoryRecall: (recalled: string) => void
  readonly tryAttachClipboardImage: () => Promise<void>
}): {
  readonly handleKeyDown: (key: KeyEvent) => void
  readonly handleSubmit: (mode?: "auto" | "steer") => void
  readonly handleContentChange: () => void
} {
  const {
    props,
    dialog,
    getTextarea,
    bashMode,
    setBashMode,
    bashAvailable,
    liveBuffer,
    setLiveBuffer,
    setLiveCursor,
    setBuffer,
    slashOpen,
    slashMatches,
    slashCursor,
    setSlashCursor,
    mention,
    historyNav,
    imageRegistry,
    pasteHint,
    setPasteHint,
    applyHistoryRecall,
    tryAttachClipboardImage,
  } = deps

  /** opentui calls this on every textarea content change. */
  function handleContentChange(): void {
    const ref = getTextarea()
    if (!ref) return
    const newText = ref.plainText
    // Once the user types/edits while history-recalled, treat that
    // as "leaving history" — the buffer is no longer a recalled
    // entry, it's a new draft. This matches readline / Claude Code
    // behavior. We don't restore the snapshot; the user's edit IS
    // the new live state.
    if (historyNav.isActive()) historyNav.reset()
    // Drop any "no image on clipboard" hint as soon as the user
    // starts typing — they've moved on, the message would just
    // squat in the footer otherwise.
    if (pasteHint() !== null) setPasteHint(null)
    setLiveBuffer(newText)
    setLiveCursor(ref.cursorOffset)
    props.onDraftChange(newText)
  }

  /**
   * Pre-handler for raw key events. Runs BEFORE the textarea's own
   * `handleKeyPress`. We use this to intercept up/down for history
   * navigation when the cursor is at the buffer edges. PreventDefault
   * stops the textarea from then trying to move the caret.
   *
   * IMPORTANT: do NOT preventDefault for keys we don't handle here,
   * or the textarea will become unusable (text input goes through
   * `handleKeyPress` too).
   */
  function handleKeyDown(key: KeyEvent): void {
    // Bash-mode entry — empty buffer + `!` keystroke flips us into bash
    // mode and SWALLOWS the `!` so it doesn't end up in the textarea.
    // Mirrors claude-code's `isInputModeCharacter` check. Modifier
    // gate: ctrl/meta/super out (those are chord prefixes); shift
    // stays in scope because most US layouts produce `!` via shift+1
    // and ship the shift modifier in the keypress event. We key off
    // `sequence === "!"` instead of `name === "!"` because some
    // terminals name the key by base-code (e.g. "1") and only the
    // sequence reflects the rendered character.
    if (
      bashAvailable() &&
      !bashMode() &&
      liveBuffer().length === 0 &&
      key.sequence === "!" &&
      !key.ctrl &&
      !key.meta &&
      !key.super
    ) {
      setBashMode(true)
      key.preventDefault()
      return
    }
    // Bash-mode exit — backspace or escape on an empty bash buffer
    // pops us back into prompt mode. Empty-buffer gate matters: in
    // bash mode with a half-typed command, backspace deletes a char
    // (and escape falls through to the textarea / dropdown handlers).
    if (
      bashMode() &&
      liveBuffer().length === 0 &&
      (key.name === "backspace" || key.name === "escape") &&
      !key.ctrl &&
      !key.meta &&
      !key.super
    ) {
      setBashMode(false)
      key.preventDefault()
      return
    }
    // ctrl+enter — steer. Submits the current buffer with mode='steer'
    // so the chat shell asks the orchestrator to interrupt the
    // in-flight subprocess before running the new prompt. We intercept
    // BEFORE the textarea's own keybindings (which would otherwise
    // pass ctrl+return through to the default `return → submit`
    // handler and lose the modifier intent).
    //
    // Only fires when the dropdown is closed: with the slash menu
    // open, ctrl+enter would feel like "run with extra meaning" but
    // there's no useful extra meaning for a slash command — we let
    // it fall through to the slash-selection path below.
    if (key.name === "return" && key.ctrl && !slashOpen()) {
      handleSubmit("steer")
      key.preventDefault()
      return
    }
    // Ctrl+R — cross-task prompt-history palette (KOB-154). Runs ahead
    // of the textarea / slash dropdown / history nav so the chord wins
    // regardless of buffer state; the textarea has no default ctrl+r
    // action so we're not shadowing anything. The chord is inert when
    // the parent didn't thread `taskLabelForHistoryKey` (i.e. the host
    // composer isn't wired up for cross-task labels) — we still open
    // the palette, but each row falls back to "no task label".
    if (key.name === "r" && key.ctrl && !key.shift && !key.meta && !key.super) {
      const resolver = props.taskLabelForHistoryKey ?? (() => undefined)
      void HistoryPalette.show(dialog, {
        taskLabelFor: resolver,
        currentProject: props.currentProjectRoot?.(),
      }).then((picked) => {
        if (picked !== undefined) applyHistoryRecall(picked)
      })
      key.preventDefault()
      return
    }
    // shift+tab cycles the per-task permission mode. Highest priority
    // because we want it consistent regardless of dropdown state.
    // Falls through silently when the parent doesn't supply a cycler.
    if (isPermissionModeCycleKey(key)) {
      if (props.onCyclePermissionMode) {
        props.onCyclePermissionMode()
        key.preventDefault()
      }
      return
    }
    // Ctrl+V — explicit "attach clipboard image". Runs ahead of slash
    // dropdown / history nav so the user can paste a screenshot mid-
    // way through composing without first dismissing autocomplete.
    // Only fires on plain `ctrl+v` (no shift / meta / super) — the
    // textarea has no default `ctrl+v` action, so swallowing this
    // chord doesn't break anything.
    //
    // Why a hotkey at all: most terminals don't forward image bytes
    // through bracketed paste (Cmd+V on a screenshot in iTerm2 is a
    // no-op), so the user needs an explicit gesture. Ctrl+V is what
    // claude-code uses for the same reason, and it passes through to
    // the app on macOS / Linux terminals (Cmd+V / Ctrl+Shift+V are
    // the terminal-level paste shortcuts; Ctrl+V is application-level).
    if (key.name === "v" && key.ctrl && !key.shift && !key.meta && !key.super) {
      // Always claim the chord — it has no default behavior in the
      // textarea — and let the async clipboard read land its token (or
      // a paste hint) when it resolves.
      key.preventDefault()
      void tryAttachClipboardImage()
      return
    }
    // Atomic delete of `[Image #N]` placeholders on plain backspace /
    // delete. Falls through to the textarea's default delete when the
    // cursor isn't adjacent to a token, when there's an active
    // selection, or when modifiers are held (so ctrl+w word-delete
    // still does its thing). See {@link deleteImageTokenBackward} for
    // why partial token deletes would silently corrupt the @path
    // expansion at submit time.
    if (key.name === "backspace" && !key.ctrl && !key.meta && !key.super && !key.shift) {
      if (deleteImageTokenBackward(getTextarea())) {
        key.preventDefault()
        return
      }
    }
    if (key.name === "delete" && !key.ctrl && !key.meta && !key.super && !key.shift) {
      if (deleteImageTokenForward(getTextarea())) {
        key.preventDefault()
        return
      }
    }
    if (mention.handleKeyDown(key)) return

    // Slash-dropdown nav has higher priority than history nav. When
    // the dropdown is open, up/down move the highlighted command, tab
    // completes the buffer with the highlighted entry's display (so the
    // user can keep typing args after the command name), esc clears
    // to dismiss, and return runs the selection.
    if (slashOpen() && slashMatches().length > 0) {
      if (key.name === "up" && !key.shift && !key.ctrl && !key.meta && !key.super) {
        const len = slashMatches().length
        setSlashCursor((cur) => (cur - 1 + len) % len)
        key.preventDefault()
        return
      }
      if (key.name === "down" && !key.shift && !key.ctrl && !key.meta && !key.super) {
        const len = slashMatches().length
        setSlashCursor((cur) => (cur + 1) % len)
        key.preventDefault()
        return
      }
      if (isPlainAutocompleteTabKey(key)) {
        // Auto-fill the buffer with the highlighted entry's display
        // (e.g. `/comp` → `/compact`). Doesn't submit — the user can
        // keep typing args or hit enter to run. Mirrors claude-code's
        // PromptInput tab-completion (refs/claude-code/src/components/
        // PromptInput/PromptInput.tsx).
        const matches = slashMatches()
        const entry = matches[slashCursor()]
        if (entry) {
          setBuffer(entry.display)
          setLiveBuffer(entry.display)
          props.onDraftChange(entry.display)
        }
        key.preventDefault()
        return
      }
      if (key.name === "escape") {
        setBuffer("")
        key.preventDefault()
        return
      }
    }

    // Ignore modifier-prefixed up/down — those are select/buffer-jump
    // bindings and the user expects them to do their normal thing.
    if (key.ctrl || key.meta || key.super) return

    if (key.name === "up" && !key.shift) {
      if (isCursorAtFirstLine(getTextarea()) && historyNav.prev()) {
        key.preventDefault()
      }
      return
    }
    if (key.name === "down" && !key.shift) {
      if (isCursorAtLastLine(getTextarea()) && historyNav.next()) {
        key.preventDefault()
      }
      return
    }
  }

  /**
   * The textarea's `submit` action fires this. Read the current
   * buffer, push to history (if non-empty), forward trimmed text
   * to the parent. Clearing happens on the parent side via the
   * `draft` reactive sync (parent calls `onDraftChange("")` after a
   * successful send).
   */
  function handleSubmit(mode: "auto" | "steer" = "auto"): void {
    const ref = getTextarea()
    if (!ref) return
    const raw = ref.plainText
    const trimmed = raw.trim()
    // Bash-mode short-circuit (Claude-Code `!cmd` parity). In bash mode
    // the buffer holds the command verbatim — the `!` was swallowed
    // at the keystroke that toggled the mode, not stored as a prefix.
    // Push the `!`-prefixed form into history so up-arrow recall can
    // distinguish bash entries from prompts later (and so a future
    // history-replay can restore the bash-mode visual). Parent owns
    // the actual shell exec via onBashCommand.
    if (bashMode()) {
      const command = trimmed
      if (command.length === 0) return // bash mode with empty buffer — no-op
      pushHistory(props.historyKey ?? "global", `!${command}`, {
        project: props.currentProjectRoot?.(),
        taskId: props.historyKey,
      })
      // Clear synchronously so the bash indicator drops before the
      // command starts streaming. Parent's draft round-trip will also
      // clear; this avoids a one-tick flicker.
      ref.setText("")
      setBuffer("")
      setLiveBuffer("")
      props.onDraftChange("")
      setBashMode(false)
      historyNav.reset()
      props.onBashCommand?.(command)
      return
    }
    // Slash short-circuit: if the dropdown is open and there's at
    // least one match, run the highlighted entry, clear the buffer,
    // and bypass the engine submit. Falls through if the user typed
    // `/unknown` or the dropdown closed already.
    if (slashOpen()) {
      const matches = slashMatches()
      const entry = matches[slashCursor()]
      if (entry) {
        setBuffer("")
        setLiveBuffer("")
        props.onDraftChange("")
        historyNav.reset()
        entry.onSelect()
        return
      }
    }
    // Expand `[Image #N]` placeholders into ` @<absPath> ` references
    // before anything downstream sees the text. We push the expanded
    // form to history (so a recall of this prompt resolves the same
    // image paths even after the in-memory registry has been cleared)
    // and hand the expanded form to the parent, which is what the
    // engine ultimately runs. Skip the regex pass when nothing was
    // pasted to keep the common path zero-cost.
    const hasImages = imageRegistry.hasEntries()
    const expandedRaw = hasImages ? imageRegistry.expand(raw) : raw
    const expandedTrimmed = hasImages ? expandedRaw.trim() : trimmed
    if (expandedTrimmed.length > 0) {
      pushHistory(props.historyKey ?? "global", expandedRaw, {
        project: props.currentProjectRoot?.(),
        taskId: props.historyKey,
      })
    }
    if (hasImages) imageRegistry.clear()
    setPasteHint(null)
    historyNav.reset()
    props.onSubmit(expandedTrimmed, mode)
  }

  return { handleKeyDown, handleSubmit, handleContentChange }
}
