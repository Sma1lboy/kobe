/** @jsxImportSource @opentui/react */
/**
 * Issue-detail dialog — the kanban page's Enter surface onto one story:
 * title + full description, status/created/link metadata, and (for a
 * startable story) the start-chat config — engine (←/→), workspace
 * placement (↑/↓), and prompt attachments.
 *
 * Attachments reuse the quick-task composer's paste grammar verbatim
 * (`tui/lib/attachments`, lifted from refs/claude-code imagePaste): pasted
 * image/PDF PATHS attach instead of inserting text, and ctrl+v asks the OS
 * clipboard for a raw image (screenshot) — saved under `~/.kobe/attachments/`
 * — or a copied file. Chips are click-to-remove; backspace drops the last.
 *
 * Resolves through the shared `showDialog` promise: `{kind:"start", …}` for
 * a startable story's Enter, `{kind:"open", taskId}` for a linked story
 * (its session already exists), undefined on esc/backdrop.
 */

import { TextAttributes } from "@opentui/core"
import { usePaste } from "@opentui/react"
import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { type ReactNode, useState } from "react"
import { ISSUE_CHAT_PLACEMENTS, type IssueChatPlacement } from "../../state/issue-chat"
import { asAttachmentPaths, attachmentLabel, captureClipboardAttachment } from "../../tui/lib/attachments"
import type { VendorId } from "../../types/task"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, showDialog, useDialog } from "../ui/dialog"

export interface IssueDetailOptions {
  readonly issue: Issue
  /** Engines to offer (detected built-ins + custom), in cycle order. */
  readonly engines: readonly VendorId[]
  readonly defaultVendor: VendorId
  readonly engineLabel: (vendor: VendorId) => string
}

/** Visible description rows before it becomes a fixed-height scrollbox. */
const DESCRIPTION_VIEW_ROWS = 10
/** Rough wrap width inside the large (110-col) dialog card: padding + the
 *  content box's border/padding leave ~100 text columns. */
const DESCRIPTION_WRAP_COLS = 100

/** Word-wrap line estimate — ceil(len/width) per hard line, min 1. */
export function estimateWrappedLines(text: string, width: number): number {
  if (!text) return 1
  return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0)
}

export type IssueDetailOutcome =
  | {
      kind: "start"
      vendor: VendorId
      placement: IssueChatPlacement
      attachments: readonly string[]
    }
  | { kind: "open"; taskId: string }

function IssueDetailDialogView(
  props: IssueDetailOptions & {
    onSubmit: (outcome: IssueDetailOutcome) => void
    onCancel: () => void
  },
) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const issue = props.issue
  const linkedTaskId = issue.taskId && issue.taskId !== "" ? issue.taskId : null
  const startable = !linkedTaskId && issue.status !== "done"

  const [vendor, setVendor] = useState<VendorId>(props.defaultVendor)
  const [placement, setPlacement] = useState<IssueChatPlacement>("worktree")
  const [attachments, setAttachments] = useState<readonly string[]>([])

  // Pasted text that is entirely image/PDF path(s) becomes attachments —
  // the quick-task composer's paste contract, verbatim.
  usePaste((event: { bytes: Uint8Array; preventDefault: () => void }) => {
    if (!startable) return
    const paths = asAttachmentPaths(new TextDecoder().decode(event.bytes))
    if (!paths) return
    event.preventDefault()
    setAttachments((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))])
  })

  function pasteAttachment(): void {
    void captureClipboardAttachment().then((path) => {
      if (path) setAttachments((prev) => (prev.includes(path) ? prev : [...prev, path]))
    })
  }

  function stepEngine(dir: 1 | -1): void {
    const list = props.engines
    if (list.length === 0) return
    setVendor((v) => {
      const i = Math.max(0, list.indexOf(v))
      return list[(i + dir + list.length) % list.length] ?? v
    })
  }

  function stepPlacement(dir: 1 | -1): void {
    setPlacement((p) => {
      const i = ISSUE_CHAT_PLACEMENTS.indexOf(p)
      return ISSUE_CHAT_PLACEMENTS[(i + dir + ISSUE_CHAT_PLACEMENTS.length) % ISSUE_CHAT_PLACEMENTS.length] ?? p
    })
  }

  function commit(): void {
    if (startable) {
      props.onSubmit({ kind: "start", vendor, placement, attachments })
    } else if (linkedTaskId) {
      props.onSubmit({ kind: "open", taskId: linkedTaskId })
    } else {
      return // done + unlinked — nothing to do on enter
    }
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "return", cmd: () => commit() },
      ...(startable
        ? [
            { key: "left", cmd: () => stepEngine(-1) },
            { key: "right", cmd: () => stepEngine(1) },
            { key: "up", cmd: () => stepPlacement(-1) },
            { key: "down", cmd: () => stepPlacement(1) },
            { key: "ctrl+v", cmd: () => pasteAttachment() },
            { key: "backspace", cmd: () => setAttachments((prev) => prev.slice(0, -1)) },
          ]
        : []),
    ],
  }))

  const description = issue.body.trim()
  const descriptionLines = estimateWrappedLines(description, DESCRIPTION_WRAP_COLS)
  const statusFg =
    issue.status === "done"
      ? theme.success
      : issue.status === "hold"
        ? theme.warning
        : issue.status === "doing"
          ? theme.accent
          : theme.textMuted

  /** BOLD CAPS section header with a muted key hint — the board's grammar. */
  const sectionHeader = (label: string, hint?: string): ReactNode => (
    <box flexDirection="row" gap={2}>
      <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
        {label}
      </text>
      {hint ? (
        <text fg={theme.textMuted} wrapMode="none">
          {hint}
        </text>
      ) : null}
    </box>
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" flexShrink={1}>
          <text fg={theme.textMuted} wrapMode="none">
            #{issue.id}{" "}
          </text>
          <text attributes={TextAttributes.BOLD} fg={theme.text} wrapMode="word" flexShrink={1}>
            {issue.title}
          </text>
        </box>
        <text
          fg={theme.textMuted}
          wrapMode="none"
          onMouseUp={() => {
            props.onCancel()
            dialog.clear()
          }}
        >
          esc
        </text>
      </box>

      <box flexDirection="row" gap={2}>
        <text fg={statusFg} attributes={TextAttributes.BOLD} wrapMode="none">
          {t(`kanban.detail.status.${issue.status}`)}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {t("kanban.detail.created", { date: issue.created })}
        </text>
        {linkedTaskId ? (
          <text fg={theme.accent} wrapMode="none">
            {t("kanban.detail.linked")}
          </text>
        ) : null}
      </box>

      {/* DESCRIPTION — the card's two-line preview uncapped, on its own
          bordered surface. A short body hugs its content (plain box); only a
          long one mounts a fixed-height scrollbox — scrollbox always fills
          its parent, so an unconditional one stretched the drawer with dead
          rows. Line estimate wraps at ~content width; CJK/wide glyphs may
          under-count, which at worst scrolls one line earlier. */}
      <box gap={0}>
        {sectionHeader(t("kanban.detail.description"))}
        <box
          border={true}
          borderColor={theme.borderSubtle}
          backgroundColor={theme.backgroundElement}
          paddingLeft={1}
          paddingRight={1}
        >
          {descriptionLines > DESCRIPTION_VIEW_ROWS ? (
            <scrollbox
              height={DESCRIPTION_VIEW_ROWS}
              verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
            >
              <text fg={theme.text} wrapMode="word">
                {description}
              </text>
            </scrollbox>
          ) : description ? (
            <text fg={theme.text} wrapMode="word">
              {description}
            </text>
          ) : (
            <text fg={theme.textMuted}>{t("kanban.detail.noDescription")}</text>
          )}
        </box>
      </box>

      {startable ? (
        <box gap={1}>
          {/* ATTACHMENTS — chips only when something is attached; the paste
              hint rides the header so the empty state costs one line. */}
          <box gap={0}>
            {sectionHeader(t("kanban.detail.attachments"), t("kanban.detail.attachHint"))}
            {attachments.length > 0 ? (
              <box flexDirection="row" gap={1} flexWrap="wrap">
                {attachments.map((path, i) => (
                  <box
                    key={path}
                    border={true}
                    borderColor={theme.borderSubtle}
                    backgroundColor={theme.backgroundElement}
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseUp={() => setAttachments((prev) => prev.filter((p) => p !== path))}
                  >
                    <text fg={theme.primary} wrapMode="none">
                      {attachmentLabel(path, i)} ×
                    </text>
                  </box>
                ))}
              </box>
            ) : null}
          </box>

          {/* ENGINE — chip buttons; the selected vendor gets the active
              border + primary bold, the rest stay subtle. */}
          <box gap={0}>
            {sectionHeader(t("kanban.detail.engine"), "←/→")}
            <box flexDirection="row" gap={1}>
              {props.engines.map((engine) => {
                const selected = engine === vendor
                return (
                  <box
                    key={engine}
                    border={true}
                    borderColor={selected ? theme.borderActive : theme.borderSubtle}
                    backgroundColor={selected ? theme.backgroundElement : undefined}
                    paddingLeft={2}
                    paddingRight={2}
                    onMouseUp={() => setVendor(engine)}
                  >
                    <text
                      fg={selected ? theme.primary : theme.textMuted}
                      attributes={selected ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                    >
                      {props.engineLabel(engine)}
                    </text>
                  </box>
                )
              })}
            </box>
          </box>

          {/* WORKSPACE — the three placements as one grouped, bordered list. */}
          <box gap={0}>
            {sectionHeader(t("kanban.detail.workspace"), "↑/↓")}
            <box
              border={true}
              borderColor={theme.borderSubtle}
              backgroundColor={theme.backgroundElement}
              paddingLeft={1}
              paddingRight={1}
            >
              {ISSUE_CHAT_PLACEMENTS.map((option) => {
                const active = option === placement
                return (
                  <text
                    key={option}
                    fg={active ? theme.primary : theme.textMuted}
                    attributes={active ? TextAttributes.BOLD : undefined}
                    onMouseUp={() => setPlacement(option)}
                  >
                    {active ? "▸ " : "  "}
                    {t(`kanban.detail.placement.${option}`)}
                  </text>
                )
              })}
            </box>
          </box>

          <box paddingBottom={1}>
            <text fg={theme.textMuted}>{t("kanban.detail.startLegend")}</text>
          </box>
        </box>
      ) : (
        <box paddingBottom={1}>
          <text fg={theme.textMuted}>{linkedTaskId ? t("kanban.detail.openLegend") : t("kanban.detail.doneNote")}</text>
        </box>
      )}
    </box>
  )
}

function show(dialog: DialogContext, opts: IssueDetailOptions): Promise<IssueDetailOutcome | undefined> {
  return showDialog<IssueDetailOutcome>(
    dialog,
    (resolve) => (
      <IssueDetailDialogView {...opts} onSubmit={(outcome) => resolve(outcome)} onCancel={() => resolve(undefined)} />
    ),
    { size: "large" },
  )
}

export const IssueDetailDialog = { show }
