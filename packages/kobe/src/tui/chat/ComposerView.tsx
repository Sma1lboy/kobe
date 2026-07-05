import { EmptyBorder, SplitBorder } from "@/tui/component/border"
import type { Theme } from "@/tui/context/theme"
import { t } from "@/tui/i18n"
import { type KeyEvent, type PasteEvent, TextAttributes, type TextareaRenderable } from "@opentui/core"
import { For, Show } from "solid-js"
import type { ComposerSlashEntry } from "./Composer"
import { ComposerPathChips } from "./ComposerPathChips"
import { ComposerQueue, type ComposerQueuedItem } from "./ComposerQueue"
import type { DropdownWindow } from "./composer/dropdown-window"
import { composerKeyBindings } from "./composer/keybindings"
import type { MentionMatch } from "./composer/mention"
import type { PreviewablePathRef } from "./composer/path-preview"
import { resolvePlaceholder } from "./composer/placeholder"
import { formatSlashDescription } from "./composer/slash-description"

const COMPOSER_MAX_LINES = 8
const COMPOSER_MIN_LINES = 1

export type ComposerModeTone = "muted" | "accent" | "warning" | "primary"

export type ComposerModeBadge = {
  readonly label: string
  readonly tone: ComposerModeTone
}

export interface ComposerViewProps {
  readonly theme: Theme
  readonly hasTask: boolean
  readonly noTaskMessage?: string
  readonly isStreaming: boolean
  readonly draft: string
  readonly inputPlaceholder?: string
  readonly bashMode: boolean
  readonly railColor: () => Theme["primary"]
  readonly footerHint: string
  readonly modelLabel: string
  readonly permissionModeLabel: string
  readonly modeBadge: ComposerModeBadge | null
  readonly toneColor: (tone: ComposerModeTone) => Theme["primary"]
  readonly mentionOpen: boolean
  readonly mentionWindow: DropdownWindow<MentionMatch>
  readonly mentionCursor: number
  readonly slashOpen: boolean
  readonly slashMatchesLength: number
  readonly slashWindow: DropdownWindow<ComposerSlashEntry>
  readonly slashCursor: number
  readonly queue: readonly ComposerQueuedItem[]
  readonly queuePaused: boolean
  readonly onToggleQueuePause?: () => void
  readonly editingQueueId?: () => string | null
  readonly onEditQueued?: (id: string) => void
  readonly onSendQueuedNow?: (id: string) => void
  readonly onCancelQueued?: (id: string) => void
  readonly pathRefs: readonly PreviewablePathRef[]
  readonly onOpenFilePath?: (relPath: string) => void
  readonly onCyclePermissionMode?: () => void
  readonly onChooseModel?: () => void
  readonly onTextareaMount: (r: TextareaRenderable) => void
  readonly onPaste: (event: PasteEvent) => void
  readonly onContentChange: () => void
  readonly onKeyDown: (key: KeyEvent) => void
  readonly onSubmit: () => void
}

export function ComposerView(props: ComposerViewProps) {
  const theme = props.theme
  return (
    <box flexShrink={0} flexDirection="column" paddingTop={1}>
      <MentionDropdown
        theme={theme}
        open={props.mentionOpen}
        window={props.mentionWindow}
        cursor={props.mentionCursor}
        railColor={props.railColor}
      />
      <SlashDropdown
        theme={theme}
        open={props.slashOpen && props.slashMatchesLength > 0}
        window={props.slashWindow}
        cursor={props.slashCursor}
        railColor={props.railColor}
      />
      <box
        border={["left"]}
        borderColor={props.railColor()}
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
          <ComposerQueue
            queue={props.queue}
            paused={props.queuePaused}
            onTogglePause={props.onToggleQueuePause}
            editingQueueId={props.editingQueueId}
            onEditQueued={props.onEditQueued}
            onSendQueuedNow={props.onSendQueuedNow}
            onCancelQueued={props.onCancelQueued}
          />
          <ComposerPathChips hasTask={props.hasTask} refs={props.pathRefs} onOpenFilePath={props.onOpenFilePath} />
          <box flexDirection="row" gap={1} alignItems="flex-start">
            <PromptGlyph theme={theme} bashMode={props.bashMode} isStreaming={props.isStreaming} />
            <box flexGrow={1} flexShrink={1} maxHeight={COMPOSER_MAX_LINES} minHeight={COMPOSER_MIN_LINES}>
              <Show
                when={props.hasTask}
                fallback={<text fg={theme.textMuted}>{props.noTaskMessage ?? t("chat.composer.noTask")}</text>}
              >
                <textarea
                  ref={props.onTextareaMount}
                  placeholder={resolvePlaceholder({
                    isStreaming: props.isStreaming,
                    hasTask: props.hasTask,
                    noTaskMessage: props.noTaskMessage,
                    inputPlaceholder: props.inputPlaceholder,
                  })}
                  placeholderColor={theme.textMuted}
                  textColor={theme.text}
                  backgroundColor={theme.backgroundElement}
                  focusedBackgroundColor={theme.backgroundElement}
                  wrapMode="word"
                  keyBindings={composerKeyBindings}
                  onContentChange={props.onContentChange}
                  onKeyDown={props.onKeyDown}
                  onSubmit={props.onSubmit}
                />
              </Show>
            </box>
          </box>
          <ComposerFooter
            theme={theme}
            hasTask={props.hasTask}
            isStreaming={props.isStreaming}
            footerHint={props.footerHint}
            modeBadge={props.modeBadge}
            toneColor={props.toneColor}
            permissionModeLabel={props.permissionModeLabel}
            onCyclePermissionMode={props.onCyclePermissionMode}
            modelLabel={props.modelLabel}
            onChooseModel={props.onChooseModel}
          />
        </box>
      </box>
      <box
        height={1}
        border={["left"]}
        borderColor={props.railColor()}
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

function MentionDropdown(props: {
  readonly theme: Theme
  readonly open: boolean
  readonly window: DropdownWindow<MentionMatch>
  readonly cursor: number
  readonly railColor: () => Theme["primary"]
}) {
  const theme = props.theme
  return (
    <Show when={props.open}>
      <box
        flexDirection="column"
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        border={["left"]}
        borderColor={props.railColor()}
        customBorderChars={SplitBorder.customBorderChars}
      >
        <Show when={props.window.start > 0}>
          <text fg={theme.textMuted} wrapMode="none">
            ↑ {props.window.start} more
          </text>
        </Show>
        <For each={props.window.items}>
          {(match, i) => {
            const absoluteIndex = () => props.window.start + i()
            const active = () => absoluteIndex() === props.cursor
            const filename = () => {
              const idx = match.displayPath.lastIndexOf("/")
              return idx >= 0 ? match.displayPath.slice(idx + 1) : match.displayPath
            }
            const directory = () => {
              const idx = match.displayPath.lastIndexOf("/")
              return idx >= 0 ? match.displayPath.slice(0, idx) : ""
            }
            return (
              <box flexDirection="row" gap={2}>
                <text
                  fg={active() ? theme.primary : theme.text}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {active() ? "▸ " : "  "}
                  {filename()}
                </text>
                <Show when={directory().length > 0}>
                  <text fg={theme.textMuted} wrapMode="none">
                    {directory()}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
        <Show when={props.window.start + props.window.items.length < props.window.total}>
          <text fg={theme.textMuted} wrapMode="none">
            ↓ {props.window.total - props.window.start - props.window.items.length} more
          </text>
        </Show>
      </box>
    </Show>
  )
}

function SlashDropdown(props: {
  readonly theme: Theme
  readonly open: boolean
  readonly window: DropdownWindow<ComposerSlashEntry>
  readonly cursor: number
  readonly railColor: () => Theme["primary"]
}) {
  const theme = props.theme
  return (
    <Show when={props.open}>
      <box
        flexDirection="column"
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        border={["left"]}
        borderColor={props.railColor()}
        customBorderChars={SplitBorder.customBorderChars}
      >
        <Show when={props.window.start > 0}>
          <text fg={theme.textMuted} wrapMode="none">
            ↑ {props.window.start} more
          </text>
        </Show>
        <For each={props.window.items}>
          {(entry, i) => {
            const absoluteIndex = () => props.window.start + i()
            const active = () => absoluteIndex() === props.cursor
            const description = () => formatSlashDescription(entry.description)
            return (
              <box flexDirection="row" gap={2}>
                <text
                  fg={active() ? theme.primary : theme.text}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  flexShrink={0}
                >
                  {active() ? "▸ " : "  "}
                  {entry.display}
                </text>
                <Show when={entry.source === "user"}>
                  <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                    user
                  </text>
                </Show>
                <Show when={description()}>
                  <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
                    {description()}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
        <Show when={props.window.start + props.window.items.length < props.window.total}>
          <text fg={theme.textMuted} wrapMode="none">
            ↓ {props.window.total - props.window.start - props.window.items.length} more
          </text>
        </Show>
      </box>
    </Show>
  )
}

function PromptGlyph(props: { readonly theme: Theme; readonly bashMode: boolean; readonly isStreaming: boolean }) {
  const theme = props.theme
  return (
    <Show
      when={props.bashMode && !props.isStreaming}
      fallback={
        <Show
          when={props.bashMode && props.isStreaming}
          fallback={<text fg={props.isStreaming ? theme.accent : theme.primary}>{props.isStreaming ? "…" : ">"}</text>}
        >
          <box flexDirection="row">
            <text fg={theme.accent}>…</text>
            <text fg={theme.warning} attributes={TextAttributes.BOLD}>
              !
            </text>
          </box>
        </Show>
      }
    >
      <text fg={theme.warning} attributes={TextAttributes.BOLD}>
        !
      </text>
    </Show>
  )
}

function ComposerFooter(props: {
  readonly theme: Theme
  readonly hasTask: boolean
  readonly isStreaming: boolean
  readonly footerHint: string
  readonly modeBadge: ComposerModeBadge | null
  readonly toneColor: (tone: ComposerModeTone) => Theme["primary"]
  readonly permissionModeLabel: string
  readonly onCyclePermissionMode?: () => void
  readonly modelLabel: string
  readonly onChooseModel?: () => void
}) {
  const theme = props.theme
  return (
    <Show when={props.hasTask}>
      <box flexDirection="row" justifyContent="space-between" paddingTop={1} flexShrink={0}>
        <text fg={props.isStreaming ? theme.accent : theme.textMuted} wrapMode="none">
          {props.footerHint}
        </text>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <box flexDirection="row" flexShrink={0} onMouseUp={() => props.onCyclePermissionMode?.()}>
            <text fg={props.modeBadge ? props.toneColor("primary") : theme.textMuted} wrapMode="none">
              {props.permissionModeLabel}
              {props.onCyclePermissionMode ? " ▾" : ""}
            </text>
          </box>
          <box flexDirection="row" flexShrink={0} onMouseUp={() => props.onChooseModel?.()}>
            <text fg={theme.textMuted} wrapMode="none">
              {props.modelLabel}
              {props.onChooseModel ? " ▾" : ""}
            </text>
          </box>
        </box>
      </box>
    </Show>
  )
}
