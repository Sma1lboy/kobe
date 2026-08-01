/** @jsxImportSource @opentui/react */
/**
 * The automation composer — one card, Tab between fields.
 *
 * Replaces four chained single-field prompts. Those worked, but a schedule is
 * a set of decisions you make together: the cron you want depends on what the
 * prompt does, and you cannot go back a step to reconsider. One card lets the
 * whole thing be read and edited in any order.
 *
 * The schedule field carries a live preview (`previewSchedule`) because a cron
 * expression is the one input a user cannot verify by re-reading it. Showing
 * "weekdays 09:00 · in 23h · Mon 09:00" turns a silent typo into an obviously
 * wrong line before it is ever saved.
 *
 * Field order, validation and the preview are the framework-free
 * `tui/component/automation-composer.ts`; this file is rendering + keys.
 */

import { TextAttributes } from "@opentui/core"
import { useState } from "react"
import {
  type ComposerDraft,
  type ComposerField,
  EMPTY_DRAFT,
  SCHEDULE_PRESETS,
  canSubmitDraft,
  cyclePreset,
  firstIncompleteField,
  nextComposerField,
  previewSchedule,
} from "../../tui/component/automation-composer"
import { clampCursor, windowAround } from "../../tui/component/new-task-dialog/state"
import { sidebarProjectLabel } from "../../tui/panes/sidebar/groups"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, showDialog, useDialog } from "../ui/dialog"
import { PickerList } from "./new-task-dialog/picker-list"

export interface AutomationComposerResult extends ComposerDraft {}

function AutomationComposerView(props: {
  repos: readonly string[]
  defaultRepo?: string
  onSubmit: (draft: AutomationComposerResult) => void
  onCancel: () => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const t = useT()

  const [draft, setDraft] = useState<ComposerDraft>(() => ({
    ...EMPTY_DRAFT,
    repo: props.defaultRepo ?? props.repos[0] ?? "",
  }))
  const [field, setField] = useState<ComposerField>("name")
  const [repoCursor, setRepoCursor] = useState(() => {
    const at = props.repos.indexOf(props.defaultRepo ?? "")
    return at >= 0 ? at : 0
  })
  const [error, setError] = useState<string | null>(null)

  const patch = (next: Partial<ComposerDraft>): void => {
    setDraft((prev) => ({ ...prev, ...next }))
    setError(null)
  }

  const pickRepoAt = (index: number): void => {
    const repo = props.repos[clampCursor(index, props.repos.length)]
    if (!repo) return
    setRepoCursor(clampCursor(index, props.repos.length))
    patch({ repo })
  }

  function commit(): void {
    if (canSubmitDraft(draft)) {
      props.onSubmit({
        name: draft.name.trim(),
        repo: draft.repo.trim(),
        prompt: draft.prompt.trim(),
        schedule: draft.schedule.trim(),
      })
      dialog.clear()
      return
    }
    // Refusing silently would leave the user pressing Enter at a Create
    // button that never fires — jump to the field that is actually missing.
    const gap = firstIncompleteField(draft)
    if (gap) {
      setField(gap)
      setError(t(`automations.missing.${gap}`))
    }
  }

  const preview = previewSchedule(draft.schedule, Date.now())
  const repoWindow = windowAround(props.repos as string[], repoCursor)
  const repoRows = repoWindow.items.map((repo, index) => ({
    key: repo,
    body: sidebarProjectLabel(repo, props.repos),
    accent: repoWindow.start + index === repoCursor,
  }))

  useBindings(() => ({
    bindings: [
      { key: "escape", cmd: () => props.onCancel() },
      { key: "tab", cmd: () => setField((f) => nextComposerField(f, 1)) },
      { key: "shift+tab", cmd: () => setField((f) => nextComposerField(f, -1)) },
      // Repo is a list, so up/down drives it while it has focus. The other
      // fields are inputs — opentui owns their arrows.
      ...(field === "repo"
        ? [
            { key: "up", cmd: () => pickRepoAt(repoCursor - 1) },
            { key: "down", cmd: () => pickRepoAt(repoCursor + 1) },
          ]
        : []),
      // Presets are a starting point, not a constraint: ←/→ steps through
      // them and the field stays typeable.
      ...(field === "schedule"
        ? [
            { key: "left", cmd: () => patch({ schedule: cyclePreset(draft.schedule, -1) }) },
            { key: "right", cmd: () => patch({ schedule: cyclePreset(draft.schedule, 1) }) },
          ]
        : []),
      ...(field === "confirm" ? [{ key: "return", cmd: () => commit() }] : []),
    ],
  }))

  const label = (target: ComposerField, text: string) => (
    <text
      fg={field === target ? theme.primary : theme.textMuted}
      attributes={field === target ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined}
      onMouseUp={() => setField(target)}
    >
      {text}
    </text>
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("automations.newTitle")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>

      <box gap={0}>
        {label("name", t("automations.fieldName"))}
        <input
          value={draft.name}
          placeholder={t("automations.namePlaceholder")}
          focused={field === "name"}
          onMouseUp={() => setField("name")}
          onInput={(v: string) => patch({ name: v })}
          onSubmit={() => setField(nextComposerField("name"))}
        />
      </box>

      <box gap={0}>
        {label("repo", t("automations.fieldRepo"))}
        {props.repos.length === 0 ? (
          <text fg={theme.textMuted}>{t("automations.needRepo")}</text>
        ) : (
          <PickerList window={repoWindow} cursor={repoCursor} rows={repoRows} onPick={pickRepoAt} />
        )}
      </box>

      <box gap={0}>
        {label("prompt", t("automations.fieldPrompt"))}
        <input
          value={draft.prompt}
          placeholder={t("automations.promptPlaceholder")}
          focused={field === "prompt"}
          onMouseUp={() => setField("prompt")}
          onInput={(v: string) => patch({ prompt: v })}
          onSubmit={() => setField(nextComposerField("prompt"))}
        />
      </box>

      <box gap={0}>
        {label("schedule", t("automations.fieldSchedule"))}
        <input
          value={draft.schedule}
          focused={field === "schedule"}
          onMouseUp={() => setField("schedule")}
          onInput={(v: string) => patch({ schedule: v })}
          onSubmit={() => setField(nextComposerField("schedule"))}
        />
        {/* The whole point of the card: a cron is unreadable, so say when it
            actually fires, in the user's own clock. */}
        <box flexDirection="row" gap={1}>
          {preview.kind === "ok" ? (
            <text fg={theme.success} wrapMode="none">
              {`${preview.relative} · ${preview.absolute}`}
            </text>
          ) : (
            <text fg={theme.error} wrapMode="none">
              {preview.kind === "never" ? t("automations.cronNever") : t("automations.cronInvalid")}
            </text>
          )}
          {field === "schedule" ? (
            <text fg={theme.textMuted} wrapMode="none">
              {t("automations.presetHint")}
            </text>
          ) : null}
        </box>
        {field === "schedule" ? (
          <text fg={theme.textMuted} wrapMode="none">
            {SCHEDULE_PRESETS.map((p) => (p.cron === draft.schedule.trim() ? `▸${t(p.labelKey)}` : ` ${t(p.labelKey)}`))
              .join("  ")
              .trim()}
          </text>
        ) : null}
      </box>

      {error ? (
        <text fg={theme.error} wrapMode="word">
          ※ {error}
        </text>
      ) : null}

      {/* The dialog shell only owns paddingTop; the last row has to carry its
          own bottom cell or it sits flush against the card's edge. */}
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text
          fg={field === "confirm" ? theme.primary : theme.textMuted}
          attributes={field === "confirm" ? TextAttributes.BOLD : undefined}
          onMouseUp={() => commit()}
        >
          {`[ ${t("common.create")} ]`}
        </text>
        <text fg={theme.textMuted}>{t("automations.composerKeys")}</text>
      </box>
    </box>
  )
}

export const AutomationComposer = {
  show(
    dialog: DialogContext,
    opts: { repos: readonly string[]; defaultRepo?: string },
  ): Promise<AutomationComposerResult | undefined> {
    return showDialog<AutomationComposerResult>(dialog, (resolve) => (
      <AutomationComposerView
        repos={opts.repos}
        {...(opts.defaultRepo ? { defaultRepo: opts.defaultRepo } : {})}
        onSubmit={(draft) => resolve(draft)}
        onCancel={() => resolve(undefined)}
      />
    ))
  },
}
