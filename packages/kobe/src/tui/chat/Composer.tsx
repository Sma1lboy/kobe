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
 *   - The placeholder cadence (see `composer/placeholder.ts`) — the
 *     engine-supplied `inputPlaceholder` (e.g. "Ask Claude…") or the
 *     i18n "Type a prompt…" fallback when idle, empty while a turn is
 *     in flight (the prefix glyph recolors instead), "(no task — press
 *     n to create)" when no task is selected.
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

import { useFocus } from "@/tui/context/focus"
import { useTheme } from "@/tui/context/theme"
import { useDialog } from "@/tui/ui/dialog"
import type { TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { type ComposerModeTone, ComposerView } from "./ComposerView"
import { makeDropdownWindow } from "./composer/dropdown-window"
import { getHistory } from "./composer/history"
import { PromptHistoryNavigator } from "./composer/history-nav"
import { createImageAttach } from "./composer/image-attach"
import { ImagePasteRegistry } from "./composer/image-paste"
import { createKeyRouter } from "./composer/key-router"
import { createMentionController } from "./composer/mention-controller"
import type { ComposerProps, ComposerSlashEntry } from "./composer/props"

export type { ComposerProps, ComposerSlashEntry }

export function Composer(props: ComposerProps) {
  const { theme } = useTheme()
  const focusCtx = useFocus()
  const dialog = useDialog()

  // Imperative ref to the textarea renderable. Set via the `ref` prop
  // callback once opentui mounts the node. We need imperative access
  // for: (a) syncing parent's `draft` onto the buffer when it
  // diverges (e.g. cleared after submit), (b) reading the cursor
  // position to decide whether to swallow up/down for history nav,
  // (c) directly calling `setText`/`focus`/`submit` from handlers.
  let textareaRef: TextareaRenderable | undefined

  // History recall is bash-mode-aware: the live-draft snapshot encodes
  // bash mode as a leading `!` (the same on-disk shape submit uses, see
  // handleSubmit's `pushHistory(key, \`!${command}\`)`). The setter
  // mirrors that — a recalled `!`-prefixed entry strips the `!`, sets
  // the buffer to the rest, and flips bash mode back on so the user
  // gets the same visual state as when they originally submitted.
  // Without this, up-arrow on a `!ls`-style entry just dumps the raw
  // `!ls` into the textarea as a normal prompt and the user has to
  // re-trigger bash mode by hand. Gated on `bashAvailable()` so a
  // composer without `onBashCommand` shows the `!` verbatim (the
  // history could have been seeded by a prior composer that had bash
  // wired up — better to expose the raw text than silently swallow it).
  //
  // Extracted as a function so the Ctrl+R palette (KOB-154) and the
  // up-arrow recall both route through identical logic — the palette
  // returns the raw stored value (`!cmd` for bash) just like the
  // history ring does, so the same dispatch shape applies.
  function applyHistoryRecall(recalled: string): void {
    if (recalled.startsWith("!") && bashAvailable()) {
      setBuffer(recalled.slice(1))
      setBashMode(true)
      return
    }
    setBuffer(recalled)
    setBashMode(false)
  }
  const historyNav = new PromptHistoryNavigator(
    () => getHistory(props.historyKey ?? "global"),
    () => {
      const text = textareaRef?.plainText ?? ""
      return bashMode() ? `!${text}` : text
    },
    applyHistoryRecall,
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

  const { handlePaste, tryAttachClipboardImage } = createImageAttach({
    getTextarea: () => textareaRef,
    imageRegistry,
    setPasteHint,
  })

  const { handleKeyDown, handleSubmit, handleContentChange } = createKeyRouter({
    props,
    dialog,
    getTextarea: () => textareaRef,
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
  })

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
      queuePaused={props.queuePaused?.() ?? false}
      onToggleQueuePause={props.onToggleQueuePause}
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
