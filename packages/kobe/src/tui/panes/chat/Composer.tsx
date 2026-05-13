/**
 * Wave 4 W4.C — multi-line chat composer.
 *
 * What this owns:
 *
 *   - The prefix glyph (`>` / `…`).
 *   - The multi-line `<textarea>` input with custom keybindings:
 *       * plain enter           → submit
 *       * shift+enter           → newline (kitty / CSI-u terminals)
 *       * ctrl+J / linefeed     → newline (universal fallback)
 *   - Per-key prompt history (in-memory): up arrow at line 1 recalls
 *     the previous submission, down arrow at the last line walks
 *     forward (and falls off the end into the live draft).
 *   - The placeholder cadence — "Ask Claude…" by default, "(streaming
 *     — wait for done)" while a turn is in flight, "(no task — press n
 *     to create)" when no task is selected.
 *   - Bracketed paste support — opentui's textarea handles multi-line
 *     paste natively, no flicker, no per-character replay. We don't
 *     have to do anything; the renderable's `handlePaste` decodes
 *     bytes and inserts in one shot.
 *   - Image paste — two entry points, one shared core. (a) Bracketed-
 *     paste with `metadata.mimeType` starting with `image/` is caught
 *     by our `onPaste` override and routed to the
 *     {@link ImagePasteRegistry}. (b) `Ctrl+V` reads the OS clipboard
 *     directly (macOS `osascript`; Linux/Windows are stubs that
 *     surface a "not yet supported" hint) for terminals that don't
 *     forward image bytes through bracketed paste — which is most of
 *     them today. Either way the user sees a `[Image #N]` placeholder
 *     in the textarea; on submit, tokens expand to ` @<absPath> ` so
 *     the engine sees an `@path` reference (the only image-input
 *     channel the `claude` CLI exposes). See `image-paste.ts` for the
 *     why-it-must-be-`@path` lecture.
 *
 * Architectural notes:
 *
 *   - The textarea is the source of truth for the buffer. We expose
 *     changes to the parent via `onDraftChange` so it stays informed
 *     (the parent uses the draft to gate the empty-buffer "enter
 *     toggles last tool" behavior). We also pull the parent's draft
 *     into the textarea on mount and when it diverges (e.g. parent
 *     clears it after submit).
 * Props contract: extends the original {@link ComposerProps} from the
 * Wave 4 split — every new prop is optional so {@link Chat.tsx} keeps
 * working without changes.
 */

import type { KeyEvent, PasteEvent, TextareaRenderable } from "@opentui/core"
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { PermissionMode } from "../../../types/engine"
import type { SlashEntry } from "../../context/command-palette"
import { useFocus } from "../../context/focus"
import { useTheme } from "../../context/theme"
import { type ComposerModeTone, ComposerView } from "./ComposerView"
import { clipboardImageSupported } from "./composer/clipboard-image"
import { isCursorAtFirstLine, isCursorAtLastLine } from "./composer/cursor"
import { makeDropdownWindow } from "./composer/dropdown-window"
import { getHistory, pushHistory } from "./composer/history"
import { PromptHistoryNavigator } from "./composer/history-nav"
import { ImagePasteRegistry } from "./composer/image-paste"
import { deleteImageTokenBackward, deleteImageTokenForward } from "./composer/image-token-delete"
import { isPermissionModeCycleKey } from "./composer/keys"
import { createMentionController } from "./composer/mention-controller"

/**
 * Slash entry with an optional `source` discriminator. Defined as an
 * extension of {@link SlashEntry} (rather than mutating the base type
 * in `command-palette.tsx`) so non-chat callers of the palette stay
 * source-agnostic. Chat.tsx tags each merged entry; the dropdown row
 * renders a muted `user` tag for entries that came from the user's
 * own `.claude/{commands,skills}/` (project or global) and leaves
 * the bundled claude-code surface unmarked.
 */
export type ComposerSlashEntry = SlashEntry & {
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
   * Stable string used to scope prompt history. Defaults to the
   * sentinel `"global"` so callers that don't pass it still get a
   * working history. Recommended: pass the active task id so each
   * task gets its own ring (matches the "iterate on the same problem"
   * use case better than a global pool of all your prompts).
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
  queue?: Accessor<
    readonly (
      | { readonly id: string; readonly kind: "prompt"; readonly text: string }
      | { readonly id: string; readonly kind: "bash"; readonly command: string }
    )[]
  >
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
}

export function Composer(props: ComposerProps) {
  const { theme } = useTheme()
  const focusCtx = useFocus()

  // Imperative ref to the textarea renderable. Set via the `ref` prop
  // callback once opentui mounts the node. We need imperative access
  // for: (a) syncing parent's `draft` onto the buffer when it
  // diverges (e.g. cleared after submit), (b) reading the cursor
  // position to decide whether to swallow up/down for history nav,
  // (c) directly calling `setText`/`focus`/`submit` from handlers.
  let textareaRef: TextareaRenderable | undefined

  const historyNav = new PromptHistoryNavigator(
    () => getHistory(props.historyKey ?? "global"),
    () => textareaRef?.plainText ?? "",
    setBuffer,
  )

  // Per-composer image-paste registry. Owns disk writes for pasted
  // PNGs and the `[Image #N]` ↔ `@/abs/path` mapping. Cleared on
  // submit (so the next image starts at #1) and on history-key
  // change (a new task gets its own numbering).
  const imageRegistry = new ImagePasteRegistry()
  // Transient surfacing for "no image on clipboard" / "not yet
  // supported" hints triggered by Ctrl+V. Rendered as a one-line
  // muted notice in the inline footer; cleared by the next keystroke.
  const [pasteHint, setPasteHint] = createSignal<string | null>(null)

  // Live draft mirror used to drive slash-command filtering. We can't
  // read `props.draft` reactively without taking the parent's clear-on-
  // submit roundtrip, and we don't want to chase the textarea ref from
  // every memo. Instead `handleContentChange` writes the live buffer
  // here on every keystroke; the dropdown filter reads it.
  const [liveBuffer, setLiveBuffer] = createSignal(props.draft ?? "")
  // Live cursor offset companion to `liveBuffer`. Mention detection
  // (unlike slash detection) needs cursor context — `@foo bar @ba|` is
  // a mention on `ba`, not on `foo`. Updated alongside the buffer in
  // `handleContentChange`. Cursor-only moves (arrow keys without
  // content change) don't refresh this; the dropdown stays open in
  // that edge case, dismissable with Esc — matches opcode's behavior.
  const [liveCursor, setLiveCursor] = createSignal(props.draft?.length ?? 0)

  // Bash-mode state — mirrors claude-code's `isInputModeCharacter`
  // pattern in `refs/claude-code/src/components/PromptInput/inputModes.ts`,
  // where typing `!` on an empty buffer SWITCHES MODES instead of
  // inserting the character. Modeling this as a signal (not a memo over
  // `liveBuffer().startsWith("!")`) keeps the `!` out of the textarea —
  // an earlier draft used the prefix-check approach and the user saw
  // `!!` (prompt glyph `!` + buffer `!`). Now the buffer holds the
  // command verbatim and the glyph carries the mode.
  //
  // Entry:  empty buffer + `!` keystroke → swallow, setBashMode(true).
  // Exit:   backspace / esc on an empty buffer → setBashMode(false).
  // Reset:  on submit (so the next prompt starts in prompt mode).
  //
  // Gated on `onBashCommand` being supplied — without a handler the
  // mode toggle would be a lie.
  const [bashMode, setBashMode] = createSignal(false)
  const bashAvailable = (): boolean => props.onBashCommand != null

  // Slash dropdown state. Cursor indexes into `slashMatches()`; reset
  // to 0 whenever the match list changes (e.g. user typed another char
  // and the list shrunk).
  const [slashCursor, setSlashCursor] = createSignal(0)
  const slashOpen = createMemo(() => {
    if (!props.slashes) return false
    const buf = liveBuffer()
    // Open whenever the buffer starts with `/` AND has no whitespace
    // — once the user types past the command name (e.g. `/new bug`),
    // we step out of palette mode and fall through to normal submit.
    if (!buf.startsWith("/")) return false
    if (/\s/.test(buf)) return false
    return true
  })
  const slashMatches = createMemo<readonly ComposerSlashEntry[]>(() => {
    if (!slashOpen()) return []
    const list = props.slashes?.() ?? []
    const query = liveBuffer().toLowerCase()
    return list.filter((entry) => {
      if (entry.display.toLowerCase().startsWith(query)) return true
      return entry.aliases?.some((a) => a.toLowerCase().startsWith(query)) ?? false
    })
  })

  // Keep cursor in bounds when the match list changes.
  createEffect(() => {
    const len = slashMatches().length
    setSlashCursor((cur) => (len === 0 ? 0 : Math.min(cur, len - 1)))
  })

  // Mirror the workspace pane's focus state onto the textarea. Without
  // this, Tab-ing into the workspace highlights the rail but keystrokes
  // still go to whichever pane previously held opentui focus, and
  // Tab-ing away leaves the textarea greedily eating keys it shouldn't.
  //
  // Also tracks `focusCtx.refocusTick` so that a same-pane setFocused
  // call (re-clicking the workspace, switching chat tabs while
  // workspace was already focused) re-asserts native focus on the
  // textarea — without this, a click on a MessageList box or tab chip
  // can steal opentui focus and leave the composer silently deaf to
  // keystrokes even though the workspace pane is "focused".
  createEffect(() => {
    focusCtx.refocusTick()
    const ref = textareaRef
    if (!ref) return
    if (props.focused?.()) ref.focus()
    else ref.blur()
  })

  // Claude Code-style dropdown windowing: keep roughly eight rows
  // visible and scroll the window around the cursor.
  const SLASH_MAX_VISIBLE = 8
  const slashWindow = createMemo(() => makeDropdownWindow(slashMatches(), slashCursor(), SLASH_MAX_VISIBLE))

  const mention = createMentionController({
    worktreePath: () => props.worktreePath?.(),
    liveBuffer,
    liveCursor,
    slashOpen,
    textarea: () => textareaRef,
  })
  const previewablePathRefs = createMemo(() => {
    if (!props.onOpenFilePath) return []
    return mention.pathRefs()
  })

  /**
   * Update the textarea's text imperatively. We use `setText` (clean
   * slate, clears undo) for history recall — we don't want the user
   * to ctrl-z and find themselves looking at an old recalled prompt
   * in the undo trail. For "clear after submit," same call: the
   * empty state should also be a clean slate.
   */
  function setBuffer(text: string): void {
    const ref = textareaRef
    if (!ref) return
    if (ref.plainText === text) return
    ref.setText(text)
    // Position the cursor at the end so the user can keep typing
    // immediately after a recall. Without this, the caret stays at
    // wherever it was before — usually 0 — which feels wrong.
    ref.cursorOffset = text.length
  }

  // Sync parent's `draft` onto the textarea when it diverges. The
  // common case is "clear after submit" — parent calls
  // `onDraftChange("")` which feeds back through here. If we didn't
  // have this effect, the textarea would still hold the just-submitted
  // text. Solid's `on` makes the dep explicit so we don't loop on
  // every signal access.
  createEffect(
    on(
      () => props.draft,
      (incoming) => {
        const ref = textareaRef
        if (!ref) return
        if (ref.plainText !== incoming) {
          setBuffer(incoming)
        }
        setLiveBuffer(incoming)
      },
    ),
  )

  // Reset history nav when the active history key changes. Without
  // this, walking back through "task A" history then switching to
  // "task B" leaves us at index 4 of the old key, which is meaningless
  // for the new key.
  createEffect(
    on(
      () => props.historyKey,
      () => {
        historyNav.reset()
        // Drop pasted-image entries on task switch — the user's next
        // paste starts at `[Image #1]` again under the new task's
        // history. Files on disk persist; we only forget the in-memory
        // token map.
        imageRegistry.clear()
        setPasteHint(null)
      },
    ),
  )

  // ------- Event handlers -------

  /**
   * Insert text at the textarea's current cursor position via the
   * EditBuffer's `insertText` (so it participates in undo and the
   * cursor walks forward as expected). Falls back silently when the
   * ref isn't mounted yet.
   */
  function insertAtCursor(text: string): void {
    const ref = textareaRef
    if (!ref) return
    ref.insertText(text)
  }

  /**
   * Bracketed-paste handler. Most pastes are text — those fall through
   * to opentui's default `handlePaste` (we just don't preventDefault).
   * The image branch fires for pastes with `metadata.mimeType` starting
   * with `image/`; today no terminal we know of forwards image bytes
   * this way (macOS Cmd+V on a screenshot drops the bytes), but the
   * code path is wired in case a future terminal does, and so the
   * Ctrl+V path can share the same insertion logic.
   */
  function handlePaste(event: PasteEvent): void {
    const mime = event.metadata?.mimeType
    if (!mime || !mime.startsWith("image/")) return
    try {
      const result = imageRegistry.saveBytes(event.bytes, mime)
      // Surround with spaces so the token doesn't fuse with adjacent
      // typed text and stays cleanly tokenizable for the on-submit
      // expansion regex.
      insertAtCursor(` ${result.token} `)
      setPasteHint(null)
      event.preventDefault()
    } catch (err) {
      // Disk write failed (permissions, no space, etc.). Surface a
      // hint and let the default paste try its luck — at worst the
      // user sees garbled bytes inserted, which is a clear signal that
      // something went wrong on our side rather than a silent drop.
      setPasteHint(`paste failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Try to read an image off the OS clipboard and insert a placeholder
   * token at the cursor. Returns true iff an image was attached.
   * Surfaces a one-line hint when there's nothing to paste, the
   * platform isn't supported, or the read failed.
   */
  function tryAttachClipboardImage(): boolean {
    if (!clipboardImageSupported()) {
      setPasteHint(`image paste not yet supported on ${process.platform}`)
      return false
    }
    try {
      const result = imageRegistry.saveFromClipboard()
      if (!result) {
        setPasteHint("no image on clipboard")
        return false
      }
      insertAtCursor(` ${result.token} `)
      setPasteHint(null)
      return true
    } catch (err) {
      setPasteHint(`paste failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** opentui calls this on every textarea content change. */
  function handleContentChange(): void {
    const ref = textareaRef
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
      if (tryAttachClipboardImage()) {
        key.preventDefault()
      }
      // On miss (no image / unsupported platform), don't preventDefault
      // — the chord has no default behavior in the textarea anyway,
      // but leaving the event alive lets a future binding pick it up.
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
      if (deleteImageTokenBackward(textareaRef)) {
        key.preventDefault()
        return
      }
    }
    if (key.name === "delete" && !key.ctrl && !key.meta && !key.super && !key.shift) {
      if (deleteImageTokenForward(textareaRef)) {
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
      if (key.name === "tab" && !key.shift) {
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
      if (isCursorAtFirstLine(textareaRef) && historyNav.prev()) {
        key.preventDefault()
      }
      return
    }
    if (key.name === "down" && !key.shift) {
      if (isCursorAtLastLine(textareaRef) && historyNav.next()) {
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
    const ref = textareaRef
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
      pushHistory(props.historyKey ?? "global", `!${command}`)
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
      pushHistory(props.historyKey ?? "global", expandedRaw)
    }
    if (hasImages) imageRegistry.clear()
    setPasteHint(null)
    historyNav.reset()
    props.onSubmit(expandedTrimmed, mode)
  }

  onCleanup(() => {
    // Drop the ref so any straggling effects don't poke a destroyed
    // renderable. opentui handles teardown of the renderable itself.
    textareaRef = undefined
  })

  // Visual chrome lifted from refs/opencode/.../prompt/index.tsx (§ render
  // tree at line 1459): a left-rail accent bar that connects the chat
  // body to the composer, paired with a subtle `backgroundElement` fill
  // around the textarea. The corner glyph (`bottomLeft: "╹"`) joins the
  // rail to the footer hint row below — without it the rail just stops
  // mid-air and looks unfinished. Border color upgrades to
  // `theme.primary` when the workspace pane is focused so the active
  // input stands out at a glance.
  // Streaming is the only state worth surfacing in the composer footer
  // — the static "enter send · shift+enter newline · shift+tab mode"
  // hints used to live here too, but they duplicated the status bar's
  // pane-local hotkey row at the bottom of the screen. Now they're
  // sourced from `KobeKeymap` (workspace scope) and the inline footer
  // keeps only the mode + model badges.
  const streamingNotice = () => {
    if (!props.hasTask) return ""
    // bash mode dominates the footer regardless of streaming so the
    // user can SEE they're in bash mode while a turn is in flight —
    // otherwise the "enter queue · ctrl+enter steer" hint masked the
    // mode signal and the user couldn't tell they were about to queue
    // a shell command vs a regular prompt.
    if (bashMode()) return props.isStreaming ? "bash mode · enter to queue" : "bash mode · enter to run"
    if (props.isStreaming) return "enter queue · ctrl+enter steer"
    return ""
  }
  // Footer hint slot: paste-related feedback (e.g. "no image on
  // clipboard") wins over streaming because it's transient state the
  // user *just* triggered, while the streaming hint is ambient. Both
  // render in the same row, same color, so the layout doesn't jump.
  const footerHint = () => pasteHint() ?? streamingNotice()
  const modelLabel = () => props.modelLabel?.() ?? ""
  const permissionModeLabel = () =>
    props.permissionModeLabel?.() ?? (props.permissionMode?.() === "plan" ? "plan mode" : "default")

  // Mode indicator: short label + tone based on the active permission mode.
  // Plain text labels — no emoji glyphs (the previous 📋/⏵/⚠ set looked
  // out of place against the rest of kobe's monochrome chrome). The rail
  // color picks up the same tone for non-default modes; plan mode in
  // particular needs to be unmistakable so the user doesn't accidentally
  // submit a destructive prompt while the agent is planning.
  const modeBadge = createMemo<{ label: string; tone: ComposerModeTone } | null>(() => {
    const mode = props.permissionMode?.()
    return mode === "plan" ? { label: permissionModeLabel(), tone: "primary" } : null
  })
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
  // Rail color priority: non-default mode > focused > idle border. Mode
  // wins over focus so the visual signal "you are in plan mode" persists
  // even when the user clicks into a sibling pane (you'd otherwise drop
  // back to the muted border and forget the mode is on).
  const railColor = () => {
    const badge = modeBadge()
    if (badge) return toneColor(badge.tone)
    if (props.focused?.()) return theme.primary
    return theme.border
  }

  function handleTextareaMount(r: TextareaRenderable): void {
    textareaRef = r
    if (props.draft) r.setText(props.draft)
    r.onPaste = handlePaste
    if (props.focused?.()) r.focus()
  }

  return (
    <ComposerView
      theme={theme}
      hasTask={props.hasTask}
      noTaskMessage={props.noTaskMessage}
      isStreaming={props.isStreaming}
      draft={props.draft}
      inputPlaceholder={props.inputPlaceholder?.()}
      bashMode={bashMode()}
      railColor={railColor}
      footerHint={footerHint()}
      modelLabel={modelLabel()}
      permissionModeLabel={permissionModeLabel()}
      modeBadge={modeBadge()}
      toneColor={toneColor}
      mentionOpen={mention.open()}
      mentionWindow={mention.window()}
      mentionCursor={mention.cursor()}
      slashOpen={slashOpen()}
      slashMatchesLength={slashMatches().length}
      slashWindow={slashWindow()}
      slashCursor={slashCursor()}
      queue={props.queue?.() ?? []}
      editingQueueId={props.editingQueueId}
      onEditQueued={props.onEditQueued}
      onSendQueuedNow={props.onSendQueuedNow}
      onCancelQueued={props.onCancelQueued}
      pathRefs={previewablePathRefs()}
      onOpenFilePath={props.onOpenFilePath}
      onCyclePermissionMode={props.onCyclePermissionMode}
      onChooseModel={props.onChooseModel}
      onTextareaMount={handleTextareaMount}
      onPaste={handlePaste}
      onContentChange={handleContentChange}
      onKeyDown={handleKeyDown}
      onSubmit={() => handleSubmit("auto")}
    />
  )
}
