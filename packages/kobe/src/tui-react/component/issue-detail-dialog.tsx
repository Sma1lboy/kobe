/** @jsxImportSource @opentui/react */
/**
 * Issue-detail dialog — the kanban page's Enter surface onto one story.
 * EDITABLE: the title rides a controlled <input>, the description an
 * UNCONTROLLED <textarea> (the settings feedback-form pattern — pasted
 * newlines survive; edits mirror out through onContentChange). `tab`
 * cycles the focused field (title → description → engine → workspace);
 * arrow keys only steer engine/workspace so they never fight the inputs'
 * cursors. `esc` SAVES dirty edits and closes (ctrl+c discards).
 *
 * Images paste INLINE: a pasted image/PDF path — or a ctrl+v clipboard
 * screenshot, saved via the composer's `captureClipboardAttachment` — is
 * appended to the description as an `images[N]: /path` placeholder line.
 * The description IS the carrier: the line persists in the issue body and
 * rides the first prompt, where the engine reads the file itself. No
 * separate attachments rail.
 *
 * Resolves through the shared `showDialog` promise with the (possibly
 * edited) title/body on EVERY outcome: `{kind:"start"|"open"|"close"}`.
 * The kanban page owns persisting a dirty patch (`issue.mutate update`).
 */

import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { usePaste } from "@opentui/react"
import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { type ReactNode, useRef, useState } from "react"
import { ISSUE_CHAT_PLACEMENTS, type IssueChatPlacement, withImagePlaceholders } from "../../state/issue-chat"
import { stripNewlines } from "../../tui/component/new-task-dialog/state"
import { asAttachmentPaths, captureClipboardAttachment } from "../../tui/lib/attachments"
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

/** Every outcome carries the drafted title/body — the page saves a dirty
 *  patch regardless of how the drawer was left. */
export type IssueDetailOutcome =
  | { kind: "start"; vendor: VendorId; placement: IssueChatPlacement; title: string; body: string }
  | { kind: "open"; taskId: string; title: string; body: string }
  | { kind: "close"; title: string; body: string }

type Field = "title" | "description" | "engine" | "workspace"

/** Description editor height — tall enough to read a story, short enough
 *  to keep the start config on screen. */
const DESCRIPTION_ROWS = 8

function IssueDetailDialogView(
  props: IssueDetailOptions & {
    onSubmit: (outcome: IssueDetailOutcome) => void
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
  const [draftTitle, setDraftTitle] = useState(issue.title)
  const [draftBody, setDraftBody] = useState(issue.body)
  // Startable stories open ready to fire (enter = start from the workspace
  // field); linked/done ones open on the title for reading/editing.
  const [field, setField] = useState<Field>(startable ? "workspace" : "title")

  // The description is an uncontrolled <textarea> (pasted newlines survive);
  // placeholder inserts write through the ref, edits mirror into draftBody.
  const bodyEl = useRef<TextareaRenderable | null>(null)

  const fields: readonly Field[] = startable
    ? ["title", "description", "engine", "workspace"]
    : ["title", "description"]

  function insertPlaceholders(paths: readonly string[]): void {
    if (paths.length === 0) return
    const next = withImagePlaceholders(bodyEl.current?.plainText ?? draftBody, paths)
    bodyEl.current?.setText(next)
    setDraftBody(next)
  }

  // Pasted text that is entirely image/PDF path(s) becomes placeholder
  // lines — the quick-task composer's paste contract, aimed at the body.
  usePaste((event: { bytes: Uint8Array; preventDefault: () => void }) => {
    const paths = asAttachmentPaths(new TextDecoder().decode(event.bytes))
    if (!paths) return
    event.preventDefault()
    insertPlaceholders(paths)
  })

  function pasteClipboardImage(): void {
    void captureClipboardAttachment().then((path) => {
      if (path) insertPlaceholders([path])
    })
  }

  function cycleField(dir: 1 | -1): void {
    setField((current) => {
      const i = Math.max(0, fields.indexOf(current))
      return fields[(i + dir + fields.length) % fields.length] ?? "title"
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

  function draft(): { title: string; body: string } {
    return {
      title: draftTitle.trim() || issue.title,
      body: bodyEl.current?.plainText ?? draftBody,
    }
  }

  function commit(): void {
    if (startable) {
      props.onSubmit({ kind: "start", vendor, placement, ...draft() })
    } else if (linkedTaskId) {
      props.onSubmit({ kind: "open", taskId: linkedTaskId, ...draft() })
    } else {
      return
    }
    dialog.clear()
  }

  function close(): void {
    props.onSubmit({ kind: "close", ...draft() })
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      // Save-and-close esc: a modal MEMBER outranks the barrier's own
      // escape, so dirty edits persist. ctrl+c (the barrier) still discards.
      { key: "escape", cmd: () => close() },
      { key: "tab", cmd: () => cycleField(1) },
      { key: "shift+tab", cmd: () => cycleField(-1) },
      { key: "ctrl+return", cmd: () => commit() },
      { key: "ctrl+v", cmd: () => pasteClipboardImage() },
      // Arrows steer ONLY the selector fields — in title/description they
      // must reach the input's own cursor, so they stay unregistered there.
      ...(field === "engine"
        ? [
            { key: "left", cmd: () => stepEngine(-1) },
            { key: "right", cmd: () => stepEngine(1) },
            { key: "return", cmd: () => commit() },
          ]
        : []),
      ...(field === "workspace"
        ? [
            { key: "up", cmd: () => stepPlacement(-1) },
            { key: "down", cmd: () => stepPlacement(1) },
            { key: "return", cmd: () => commit() },
          ]
        : []),
    ],
  }))

  const statusFg =
    issue.status === "done"
      ? theme.success
      : issue.status === "hold"
        ? theme.warning
        : issue.status === "doing"
          ? theme.accent
          : theme.textMuted

  /** Section header: BOLD CAPS, primary when its field is focused. */
  const sectionHeader = (label: string, ownField: Field | null, hint?: string): ReactNode => {
    const focused = ownField !== null && field === ownField
    return (
      <box flexDirection="row" gap={2}>
        <text
          fg={focused ? theme.primary : theme.textMuted}
          attributes={focused ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.BOLD}
          wrapMode="none"
        >
          {label}
        </text>
        {hint ? (
          <text fg={theme.textMuted} wrapMode="none">
            {hint}
          </text>
        ) : null}
      </box>
    )
  }

  // Focused/selected frames light up PRIMARY — the same accent the kanban
  // card cursor and the pane focus grammar use, not the generic borderActive.
  const frameColor = (ownField: Field) => (field === ownField ? theme.primary : theme.borderSubtle)

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={2}>
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
            #{issue.id}
          </text>
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
        <text fg={theme.textMuted} wrapMode="none" onMouseUp={() => close()}>
          esc
        </text>
      </box>

      {/* TITLE — controlled input, single line. Enter walks to the body. */}
      <box gap={0}>
        {sectionHeader(t("kanban.detail.titleLabel"), "title")}
        <box
          border={true}
          borderColor={frameColor("title")}
          backgroundColor={theme.backgroundElement}
          paddingLeft={1}
          paddingRight={1}
        >
          <input
            value={draftTitle}
            focused={field === "title"}
            onMouseUp={() => setField("title")}
            onInput={(v: string) => setDraftTitle(stripNewlines(v))}
            onSubmit={() => setField("description")}
          />
        </box>
      </box>

      {/* DESCRIPTION — uncontrolled multiline editor; pasted image paths and
          ctrl+v screenshots append `images[N]: /path` placeholder lines. */}
      <box gap={0}>
        {sectionHeader(t("kanban.detail.description"), "description", t("kanban.detail.attachHint"))}
        <box
          border={true}
          borderColor={frameColor("description")}
          backgroundColor={theme.backgroundElement}
          paddingLeft={1}
          paddingRight={1}
        >
          <textarea
            ref={(el: TextareaRenderable | null) => {
              bodyEl.current = el
            }}
            initialValue={issue.body}
            placeholder={t("kanban.detail.noDescription")}
            focused={field === "description"}
            height={DESCRIPTION_ROWS}
            wrapMode="word"
            onMouseUp={() => setField("description")}
            onContentChange={() => setDraftBody(bodyEl.current?.plainText ?? "")}
          />
        </box>
      </box>

      {startable ? (
        <box gap={1}>
          {/* ENGINE — chip buttons; selected = active border + primary bold. */}
          <box gap={0}>
            {sectionHeader(t("kanban.detail.engine"), "engine", "←/→")}
            <box flexDirection="row" gap={1}>
              {props.engines.map((engine) => {
                const selected = engine === vendor
                return (
                  <box
                    key={engine}
                    border={true}
                    borderColor={selected ? theme.primary : theme.borderSubtle}
                    backgroundColor={selected ? theme.backgroundElement : undefined}
                    paddingLeft={2}
                    paddingRight={2}
                    onMouseUp={() => {
                      setField("engine")
                      setVendor(engine)
                    }}
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
            {sectionHeader(t("kanban.detail.workspace"), "workspace", "↑/↓")}
            <box
              border={true}
              borderColor={frameColor("workspace")}
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
                    onMouseUp={() => {
                      setField("workspace")
                      setPlacement(option)
                    }}
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
    (resolve) => <IssueDetailDialogView {...opts} onSubmit={(outcome) => resolve(outcome)} />,
    { size: "large" },
  )
}

export const IssueDetailDialog = { show }
