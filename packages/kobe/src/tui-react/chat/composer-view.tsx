/** @jsxImportSource @opentui/react */
/**
 * React presentational layer of the chat composer — the
 * `src/tui/chat/ComposerView.tsx` counterpart (issue #15 G3). Same visual
 * grammar: rail-bordered input block, mention/slash dropdowns above it,
 * queue panel + path chips inside it, mode/model badges in the footer.
 * All formatting helpers are the shared framework-free composer modules.
 */

import { type KeyEvent, TextAttributes, type TextareaRenderable } from "@opentui/core"
import type { DropdownWindow } from "../../tui/chat/composer/dropdown-window"
import { composerKeyBindings } from "../../tui/chat/composer/keybindings"
import type { MentionMatch } from "../../tui/chat/composer/mention"
import type { PreviewablePathRef } from "../../tui/chat/composer/path-preview"
import { resolvePlaceholder } from "../../tui/chat/composer/placeholder"
import type { ComposerSlashEntry } from "../../tui/chat/composer/props"
import type { ComposerQueuedItem } from "../../tui/chat/composer/queue-item"
import { formatSlashDescription } from "../../tui/chat/composer/slash-description"
import { EmptyBorder, SplitBorder } from "../../tui/component/border"
import { type Theme, useTheme } from "../context/theme"
import { useT } from "../i18n"
import { ComposerPathChips } from "./composer-path-chips"
import { ComposerQueue } from "./composer-queue"

const COMPOSER_MAX_LINES = 8
const COMPOSER_MIN_LINES = 1

export type ComposerModeTone = "muted" | "accent" | "warning" | "primary"

export type ComposerModeBadge = {
  readonly label: string
  readonly tone: ComposerModeTone
}

export interface ComposerViewProps {
  readonly hasTask: boolean
  readonly noTaskMessage?: string
  readonly isStreaming: boolean
  readonly inputPlaceholder?: string
  readonly bashMode: boolean
  readonly railColor: Theme["primary"]
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
  readonly editingQueueId?: string | null
  readonly onEditQueued?: (id: string) => void
  readonly onSendQueuedNow?: (id: string) => void
  readonly onCancelQueued?: (id: string) => void
  readonly pathRefs: readonly PreviewablePathRef[]
  readonly onOpenFilePath?: (relPath: string) => void
  readonly onCyclePermissionMode?: () => void
  readonly onChooseModel?: () => void
  readonly onTextareaMount: (r: TextareaRenderable | null) => void
  readonly onContentChange: () => void
  readonly onKeyDown: (key: KeyEvent) => void
  readonly onSubmit: () => void
}

export function ComposerView(props: ComposerViewProps) {
  const { theme } = useTheme()
  const t = useT()
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
        borderColor={props.railColor}
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
              {props.hasTask ? (
                <textarea
                  ref={props.onTextareaMount}
                  placeholder={resolvePlaceholder(
                    {
                      isStreaming: props.isStreaming,
                      hasTask: props.hasTask,
                      noTaskMessage: props.noTaskMessage,
                      inputPlaceholder: props.inputPlaceholder,
                    },
                    t,
                  )}
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
              ) : (
                <text fg={theme.textMuted}>{props.noTaskMessage ?? t("chat.composer.noTask")}</text>
              )}
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
        borderColor={props.railColor}
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
  readonly railColor: Theme["primary"]
}) {
  const theme = props.theme
  if (!props.open) return null
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={theme.backgroundElement}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      border={["left"]}
      borderColor={props.railColor}
      customBorderChars={SplitBorder.customBorderChars}
    >
      {props.window.start > 0 ? (
        <text fg={theme.textMuted} wrapMode="none">
          ↑ {props.window.start} more
        </text>
      ) : null}
      {props.window.items.map((match, i) => {
        const active = props.window.start + i === props.cursor
        const idx = match.displayPath.lastIndexOf("/")
        const filename = idx >= 0 ? match.displayPath.slice(idx + 1) : match.displayPath
        const directory = idx >= 0 ? match.displayPath.slice(0, idx) : ""
        return (
          <box key={match.path} flexDirection="row" gap={2}>
            <text
              fg={active ? theme.primary : theme.text}
              attributes={active ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              {active ? "▸ " : "  "}
              {filename}
            </text>
            {directory.length > 0 ? (
              <text fg={theme.textMuted} wrapMode="none">
                {directory}
              </text>
            ) : null}
          </box>
        )
      })}
      {props.window.start + props.window.items.length < props.window.total ? (
        <text fg={theme.textMuted} wrapMode="none">
          ↓ {props.window.total - props.window.start - props.window.items.length} more
        </text>
      ) : null}
    </box>
  )
}

function SlashDropdown(props: {
  readonly theme: Theme
  readonly open: boolean
  readonly window: DropdownWindow<ComposerSlashEntry>
  readonly cursor: number
  readonly railColor: Theme["primary"]
}) {
  const theme = props.theme
  if (!props.open) return null
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={theme.backgroundElement}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      border={["left"]}
      borderColor={props.railColor}
      customBorderChars={SplitBorder.customBorderChars}
    >
      {props.window.start > 0 ? (
        <text fg={theme.textMuted} wrapMode="none">
          ↑ {props.window.start} more
        </text>
      ) : null}
      {props.window.items.map((entry, i) => {
        const active = props.window.start + i === props.cursor
        const description = formatSlashDescription(entry.description)
        return (
          <box key={entry.display} flexDirection="row" gap={2}>
            <text
              fg={active ? theme.primary : theme.text}
              attributes={active ? TextAttributes.BOLD : undefined}
              wrapMode="none"
              flexShrink={0}
            >
              {active ? "▸ " : "  "}
              {entry.display}
            </text>
            {entry.source === "user" ? (
              <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                user
              </text>
            ) : null}
            {description ? (
              <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
                {description}
              </text>
            ) : null}
          </box>
        )
      })}
      {props.window.start + props.window.items.length < props.window.total ? (
        <text fg={theme.textMuted} wrapMode="none">
          ↓ {props.window.total - props.window.start - props.window.items.length} more
        </text>
      ) : null}
    </box>
  )
}

function PromptGlyph(props: { readonly theme: Theme; readonly bashMode: boolean; readonly isStreaming: boolean }) {
  const theme = props.theme
  if (props.bashMode && !props.isStreaming) {
    return (
      <text fg={theme.warning} attributes={TextAttributes.BOLD}>
        !
      </text>
    )
  }
  if (props.bashMode && props.isStreaming) {
    return (
      <box flexDirection="row">
        <text fg={theme.accent}>…</text>
        <text fg={theme.warning} attributes={TextAttributes.BOLD}>
          !
        </text>
      </box>
    )
  }
  return <text fg={props.isStreaming ? theme.accent : theme.primary}>{props.isStreaming ? "…" : ">"}</text>
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
  if (!props.hasTask) return null
  return (
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
  )
}
