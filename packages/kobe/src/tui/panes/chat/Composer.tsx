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
 *
 * What this does NOT own (deferred):
 *
 *   - Mention completion (`@filename`).
 *   - Slash commands inside the composer.
 *   - Image / file paste.
 *   - Cross-session history persistence (in-memory only for v1).
 *
 * Architectural notes:
 *
 *   - The textarea is the source of truth for the buffer. We expose
 *     changes to the parent via `onDraftChange` so it stays informed
 *     (the parent uses the draft to gate the empty-buffer "enter
 *     toggles last tool" behavior). We also pull the parent's draft
 *     into the textarea on mount and when it diverges (e.g. parent
 *     clears it after submit).
 *   - History navigation only fires when the cursor is at the
 *     buffer's first line (going up) or last line (going down). In
 *     between, up/down move the caret like a normal multi-line editor.
 *     The opentui defaults already handle that — we just preventDefault
 *     in the cases where we want history to win.
 *   - Submit clears the textarea synchronously. The parent's
 *     `onSubmit` will then call back with `setDraft("")`, which our
 *     reactive sync turns into a no-op (already cleared).
 *
 * Props contract: extends the original {@link ComposerProps} from the
 * Wave 4 split — every new prop is optional so {@link Chat.tsx} keeps
 * working without changes.
 */

import { type KeyEvent, TextAttributes, type TextareaRenderable } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { PermissionMode } from "../../../types/engine"
import { EmptyBorder, SplitBorder } from "../../component/border"
import type { SlashEntry } from "../../context/command-palette"
import { useTheme } from "../../context/theme"
import { getHistory, pushHistory } from "./composer/history"
import { composerKeyBindings } from "./composer/keybindings"

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

/** Maximum visible lines before the textarea scrolls internally. */
const COMPOSER_MAX_LINES = 8

/** Minimum height — ensures the empty textarea is always visible. */
const COMPOSER_MIN_LINES = 1

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
  /** Called on enter with the trimmed text. Empty string = empty-composer enter. */
  onSubmit: (trimmedText: string) => void

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
}

/**
 * Resolve the placeholder text given the current state. Pure — no
 * Solid signals — so it can be unit-tested in isolation if we ever
 * want to. For now the behavior test asserts the streaming variant
 * is visible after submit.
 */
function resolvePlaceholder(opts: { isStreaming: boolean; hasTask: boolean; noTaskMessage?: string }): string {
  if (!opts.hasTask) return opts.noTaskMessage ?? "(no task — press n to create)"
  if (opts.isStreaming) return "(streaming — wait for done)"
  return "Ask Claude…"
}

export function Composer(props: ComposerProps) {
  const { theme } = useTheme()

  // Imperative ref to the textarea renderable. Set via the `ref` prop
  // callback once opentui mounts the node. We need imperative access
  // for: (a) syncing parent's `draft` onto the buffer when it
  // diverges (e.g. cleared after submit), (b) reading the cursor
  // position to decide whether to swallow up/down for history nav,
  // (c) directly calling `setText`/`focus`/`submit` from handlers.
  let textareaRef: TextareaRenderable | undefined

  // History navigation cursor. -1 means "live" (showing the user's
  // current in-progress draft). 0..N-1 indexes into entries; N means
  // "newest" (also live, but represented separately so we can walk
  // back without losing the draft). We snapshot the live draft when
  // entering history so a stray "down" off the end restores it.
  //
  // Stored as plain locals (not signals) because they don't drive any
  // render output — only effect logic.
  let historyIndex: number | null = null
  let liveDraftSnapshot = ""

  // Live draft mirror used to drive slash-command filtering. We can't
  // read `props.draft` reactively without taking the parent's clear-on-
  // submit roundtrip, and we don't want to chase the textarea ref from
  // every memo. Instead `handleContentChange` writes the live buffer
  // here on every keystroke; the dropdown filter reads it.
  const [liveBuffer, setLiveBuffer] = createSignal(props.draft ?? "")

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

  // Slash dropdown windowing — claude-code's autocomplete shows ~8 rows
  // and scrolls the window so the cursor stays visible. Without this,
  // typing `/` with 70+ commands paints the whole list and overflows
  // a small terminal. We compute the window centered on the cursor,
  // clamped to the list bounds. Indicator counts (`↑ N more` / `↓ N more`)
  // render outside the window when truncated.
  const SLASH_MAX_VISIBLE = 8
  type SlashWindow = {
    readonly items: readonly ComposerSlashEntry[]
    readonly start: number
    readonly total: number
  }
  const slashWindow = createMemo<SlashWindow>(() => {
    const matches = slashMatches()
    const total = matches.length
    if (total <= SLASH_MAX_VISIBLE) {
      return { items: matches, start: 0, total }
    }
    const cursor = slashCursor()
    const half = Math.floor(SLASH_MAX_VISIBLE / 2)
    let start = Math.max(0, cursor - half)
    if (start + SLASH_MAX_VISIBLE > total) start = total - SLASH_MAX_VISIBLE
    return { items: matches.slice(start, start + SLASH_MAX_VISIBLE), start, total }
  })

  /**
   * Read the latest entries for the active history key. Re-read each
   * time we navigate so concurrent submits (which append) are
   * reflected. Reads are cheap — the store returns a fresh array slice.
   */
  function entries(): readonly string[] {
    return getHistory(props.historyKey ?? "global")
  }

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

  /**
   * True if the caret is on the buffer's first visual line. We use
   * this to decide whether up arrow navigates history vs. moves the
   * caret. opentui exposes the cursor's logical row via
   * `editBuffer.getCursorPosition()`, but the more portable path is
   * to compute from `cursorOffset` and the text content — count
   * newlines before the offset.
   */
  function isCursorAtFirstLine(): boolean {
    const ref = textareaRef
    if (!ref) return true
    const offset = ref.cursorOffset
    const text = ref.plainText
    // A cursor is "on line 1" iff there's no newline between offset 0
    // and the cursor. We don't care about wrapped lines — those are a
    // visual artifact, not a buffer-line distinction. (If we did
    // honor visual wrap, multi-line history navigation would feel
    // janky in narrow terminals where every prompt wraps.)
    for (let i = 0; i < offset; i++) {
      if (text[i] === "\n") return false
    }
    return true
  }

  function isCursorAtLastLine(): boolean {
    const ref = textareaRef
    if (!ref) return true
    const offset = ref.cursorOffset
    const text = ref.plainText
    for (let i = offset; i < text.length; i++) {
      if (text[i] === "\n") return false
    }
    return true
  }

  /**
   * Recall an older entry: bumps `historyIndex` toward the past. If
   * already at the oldest entry, no-op. On first call (historyIndex
   * is null), snapshot the live draft so a later "off the end" walk
   * forward can restore it.
   */
  function historyPrev(): boolean {
    const list = entries()
    if (list.length === 0) return false
    if (historyIndex === null) {
      // Snapshot what the user has typed so we can restore it.
      liveDraftSnapshot = textareaRef?.plainText ?? ""
      historyIndex = list.length - 1
    } else if (historyIndex > 0) {
      historyIndex -= 1
    } else {
      // At the oldest — nothing to do.
      return true
    }
    const recalled = list[historyIndex]
    if (recalled !== undefined) setBuffer(recalled)
    return true
  }

  /**
   * Walk forward in history toward the live draft. If we step past
   * the newest entry, restore the snapshotted draft and mark history
   * as "off" again.
   */
  function historyNext(): boolean {
    const list = entries()
    if (list.length === 0 || historyIndex === null) return false
    if (historyIndex < list.length - 1) {
      historyIndex += 1
      const recalled = list[historyIndex]
      if (recalled !== undefined) setBuffer(recalled)
    } else {
      // Stepped past the newest entry — back to live draft.
      historyIndex = null
      setBuffer(liveDraftSnapshot)
      liveDraftSnapshot = ""
    }
    return true
  }

  /**
   * Reset history nav state. Called on submit (so the next `up`
   * starts from the just-pushed entry) and on task switch (when
   * the historyKey changes underneath us).
   */
  function resetHistoryNav(): void {
    historyIndex = null
    liveDraftSnapshot = ""
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
        resetHistoryNav()
      },
    ),
  )

  // ------- Event handlers -------

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
    if (historyIndex !== null) {
      historyIndex = null
      liveDraftSnapshot = ""
    }
    setLiveBuffer(newText)
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
    // shift+tab cycles the per-task permission mode. Highest priority
    // because we want it consistent regardless of dropdown state.
    // Falls through silently when the parent doesn't supply a cycler.
    if (key.name === "tab" && key.shift) {
      if (props.onCyclePermissionMode) {
        props.onCyclePermissionMode()
        key.preventDefault()
      }
      return
    }
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
      if (isCursorAtFirstLine() && historyPrev()) {
        key.preventDefault()
      }
      return
    }
    if (key.name === "down" && !key.shift) {
      if (isCursorAtLastLine() && historyNext()) {
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
  function handleSubmit(): void {
    const ref = textareaRef
    if (!ref) return
    const raw = ref.plainText
    const trimmed = raw.trim()
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
        resetHistoryNav()
        entry.onSelect()
        return
      }
    }
    if (trimmed.length > 0) {
      pushHistory(props.historyKey ?? "global", raw)
    }
    resetHistoryNav()
    props.onSubmit(trimmed)
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
  const actionHint = () => {
    if (!props.hasTask) return ""
    if (props.isStreaming) return "streaming — wait for done"
    return "enter send · shift+enter newline · shift+tab mode"
  }
  const modelLabel = () => props.modelLabel?.() ?? "claude-code"

  // Mode indicator: short label + tone based on the active permission mode.
  // We treat undefined as "default" for display so the badge always
  // renders. Plain text labels — no emoji glyphs (the previous 📋/⏵/⚠ set
  // looked out of place against the rest of kobe's monochrome chrome).
  // The rail color picks up the same tone so the composer's outer
  // chrome turns a different color for non-default modes; plan mode in
  // particular needs to be unmistakable so the user doesn't accidentally
  // submit a destructive prompt while the agent is planning.
  const modeBadge = createMemo<{ label: string; tone: "muted" | "accent" | "warning" | "primary" }>(() => {
    const mode = props.permissionMode?.()
    switch (mode) {
      case "acceptEdits":
        return { label: "accept edits", tone: "accent" }
      case "plan":
        return { label: "plan mode", tone: "primary" }
      case "auto":
        return { label: "auto", tone: "primary" }
      case "bypassPermissions":
        return { label: "bypass permissions", tone: "warning" }
      case "dontAsk":
        return { label: "don't ask", tone: "warning" }
      default:
        return { label: "default", tone: "muted" }
    }
  })
  const toneColor = (tone: "muted" | "accent" | "warning" | "primary") => {
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
  const modeBadgeColor = () => toneColor(modeBadge().tone)
  // Rail color priority: non-default mode > focused > idle border. Mode
  // wins over focus so the visual signal "you are in plan mode" persists
  // even when the user clicks into a sibling pane (you'd otherwise drop
  // back to the muted border and forget the mode is on).
  const railColor = () => {
    const tone = modeBadge().tone
    if (tone !== "muted") return toneColor(tone)
    if (props.focused?.()) return theme.primary
    return theme.border
  }

  return (
    <box flexShrink={0} flexDirection="column" paddingTop={1}>
      {/* Slash dropdown — rendered above the composer when the buffer
          starts with `/` and there's at least one match. Windowed to
          SLASH_MAX_VISIBLE entries so a 70+ command list doesn't blow
          past the chat area; the window scrolls to keep the cursor
          visible. `↑ N more` / `↓ N more` indicators surface the
          truncation. Tab completes the highlighted entry into the
          buffer (claude-code parity). */}
      <Show when={slashOpen() && slashMatches().length > 0}>
        <box
          flexDirection="column"
          flexShrink={0}
          backgroundColor={theme.backgroundElement}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          border={["left"]}
          borderColor={railColor()}
          customBorderChars={SplitBorder.customBorderChars}
        >
          <Show when={slashWindow().start > 0}>
            <text fg={theme.textMuted} wrapMode="none">
              ↑ {slashWindow().start} more
            </text>
          </Show>
          <For each={slashWindow().items}>
            {(entry, i) => {
              const absoluteIndex = () => slashWindow().start + i()
              const active = () => absoluteIndex() === slashCursor()
              return (
                <box flexDirection="row" gap={2}>
                  <text
                    fg={active() ? theme.primary : theme.text}
                    attributes={active() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {active() ? "▸ " : "  "}
                    {entry.display}
                  </text>
                  {/* User-defined entries (project or global
                      `.claude/{commands,skills}/`) render with a muted
                      `user` tag so they're distinguishable from the
                      bundled claude-code surface. Built-ins are the
                      default — leaving them unmarked keeps the dropdown
                      visually quiet for the common case. Tag uses the
                      same `theme.textMuted` token as the description
                      hint so it sits in the same visual register
                      without competing with the active-row glyph. */}
                  <Show when={entry.source === "user"}>
                    <text fg={theme.textMuted} wrapMode="none">
                      user
                    </text>
                  </Show>
                  <Show when={entry.description}>
                    <text fg={theme.textMuted} wrapMode="none">
                      {entry.description}
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
          <Show when={slashWindow().start + slashWindow().items.length < slashWindow().total}>
            <text fg={theme.textMuted} wrapMode="none">
              ↓ {slashWindow().total - slashWindow().start - slashWindow().items.length} more
            </text>
          </Show>
        </box>
      </Show>
      <box
        border={["left"]}
        borderColor={railColor()}
        customBorderChars={{
          ...SplitBorder.customBorderChars,
          bottomLeft: "╹",
        }}
      >
        <box
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={0}
          flexDirection="column"
          flexGrow={1}
          backgroundColor={theme.backgroundElement}
        >
          <box flexDirection="row" gap={1} alignItems="flex-start">
            <text fg={props.isStreaming ? theme.accent : theme.primary}>{props.isStreaming ? "…" : ">"}</text>
            <box flexGrow={1} flexShrink={1} maxHeight={COMPOSER_MAX_LINES} minHeight={COMPOSER_MIN_LINES}>
              <Show
                when={props.hasTask}
                fallback={<text fg={theme.textMuted}>{props.noTaskMessage ?? "(no task — press n to create)"}</text>}
              >
                <textarea
                  ref={(r: TextareaRenderable) => {
                    textareaRef = r
                    // Seed the buffer if the parent already has a draft
                    // (uncommon, but harmless). `setText` on the empty
                    // string is also fine — it's a no-op when content
                    // matches.
                    if (props.draft) r.setText(props.draft)
                    // Auto-focus so the user can start typing immediately
                    // after the chat pane mounts. This mirrors the prior
                    // <input focused={true}> behavior.
                    r.focus()
                  }}
                  placeholder={resolvePlaceholder({
                    isStreaming: props.isStreaming,
                    hasTask: props.hasTask,
                    noTaskMessage: props.noTaskMessage,
                  })}
                  placeholderColor={theme.textMuted}
                  textColor={theme.text}
                  backgroundColor={theme.backgroundElement}
                  focusedBackgroundColor={theme.backgroundElement}
                  wrapMode="word"
                  keyBindings={composerKeyBindings}
                  onContentChange={handleContentChange}
                  onKeyDown={handleKeyDown}
                  onSubmit={handleSubmit}
                />
              </Show>
            </box>
          </box>
          {/* Inline footer: action hint left, model right. Renders only
              when a task is selected so the no-task fallback row has the
              composer area to itself. */}
          <Show when={props.hasTask}>
            <box flexDirection="row" justifyContent="space-between" paddingTop={1} flexShrink={0}>
              <text fg={theme.textMuted} wrapMode="none">
                {actionHint()}
              </text>
              <box flexDirection="row" gap={2} flexShrink={0}>
                <text fg={modeBadgeColor()} wrapMode="none">
                  {modeBadge().label}
                </text>
                {/* Model label — clickable when the parent supplies
                    `onChooseModel`; renders with a `▾` caret to advertise
                    the picker. Inert (no caret, no click) otherwise. */}
                <box flexDirection="row" flexShrink={0} onMouseUp={() => props.onChooseModel?.()}>
                  <text fg={theme.textMuted} wrapMode="none">
                    {modelLabel()}
                    {props.onChooseModel ? " ▾" : ""}
                  </text>
                </box>
              </box>
            </box>
          </Show>
        </box>
      </box>
      {/* One-row tail under the rail to terminate the accent stroke
          cleanly with the same backgroundElement fill — opencode does
          this with a `▀` half-block bottom border so the element panel
          ends without a hard edge. EmptyBorder swaps in a space when
          the theme's element bg is fully transparent. */}
      <box
        height={1}
        border={["left"]}
        borderColor={railColor()}
        customBorderChars={{
          ...EmptyBorder,
          vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
        }}
      >
        <box
          height={1}
          border={["bottom"]}
          borderColor={theme.backgroundElement}
          customBorderChars={{
            ...EmptyBorder,
            horizontal: theme.backgroundElement.a !== 0 ? "▀" : " ",
          }}
        />
      </box>
    </box>
  )
}
