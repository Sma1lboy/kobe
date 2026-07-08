/** @jsxImportSource @opentui/react */
/**
 * Set-branch (re-branch) dialog — the sidebar `b` flow. Lists the task
 * repo's local branches with filter-as-you-type, matching the new-task
 * dialog's `fromBranch` picker (issue #10): reuses the same pure helpers
 * (`filterBranches` / `windowAround` / `clampCursor` / `resolveBaseRef`)
 * and the shared `PickerList`, so the two branch surfaces stay in lockstep.
 *
 * The input doubles as free text — typing a name not in the list renames
 * the task's branch to it (`orchestrator.setBranch` → `git branch -m`);
 * Enter resolves via `resolveBaseRef` (exact match → highlighted row →
 * typed text). Esc cancels through the dialog stack (DialogProvider owns
 * escape/ctrl+c). Branch enumeration is the one-shot sync `listLocalBranches`
 * — same whitelisted git-snapshot call the new-task view-model uses.
 */

import { TextAttributes } from "@opentui/core"
import { useMemo, useState } from "react"
import {
  type PickerWindow,
  clampCursor,
  filterBranches,
  resolveBaseRef,
  stripNewlines,
  windowAround,
} from "../../tui/component/new-task-dialog/state"
import { listLocalBranches } from "../../tui/lib/git-snapshot"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"
import { PickerList } from "./new-task-dialog/picker-list"

export function BranchPickerDialogView(props: {
  /** The task's current branch — prefills the input. */
  currentBranch: string
  /** Repo whose local branches populate the picker. */
  repo: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()

  const [value, setValue] = useState(props.currentBranch)
  const [cursor, setCursor] = useState(0)

  // One-shot enumeration on open (repo is fixed for the dialog's lifetime).
  const branches = useMemo(() => listLocalBranches(props.repo), [props.repo])
  const filtered = useMemo(() => filterBranches(branches, value), [branches, value])
  const window: PickerWindow = windowAround(filtered, cursor)

  function move(delta: 1 | -1): void {
    if (filtered.length === 0) return
    setCursor((c) => clampCursor(c + delta, filtered.length))
  }

  function commit(name: string): void {
    const next = name.trim()
    if (!next) return
    props.onSubmit(next)
    dialog.clear()
  }

  const rows = window.items.map((name, i) => ({
    key: `${window.start + i}:${name}`,
    body: name,
    accent: value.trim() === name,
  }))

  // up/down drive the picker; always registered so they preventDefault away
  // from the single-line input (same rationale as the new-task view-model).
  useBindings(() => ({
    bindings: [
      { key: "up", cmd: () => move(-1) },
      { key: "down", cmd: () => move(1) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("tasks.reBranch.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.accent}>{t("tasks.reBranch.fieldLabel")}</text>
        <input
          value={value}
          placeholder={props.currentBranch}
          focused={true}
          onInput={(v: string) => {
            setValue(stripNewlines(v))
            setCursor(0)
          }}
          onSubmit={() => commit(resolveBaseRef(value, filtered, cursor))}
        />
      </box>
      {filtered.length === 0 ? (
        <box gap={0} paddingBottom={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {branches.length === 0 ? t("tasks.reBranch.hintNoBranches") : t("tasks.reBranch.hintNoMatch")}
          </text>
        </box>
      ) : (
        <PickerList
          window={window}
          cursor={cursor}
          rows={rows}
          onPick={(absoluteIndex) => commit(filtered[absoluteIndex] ?? value)}
          paddingBottom={1}
        />
      )}
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{t("tasks.reBranch.footer")}</text>
      </box>
    </box>
  )
}

/**
 * Open the set-branch dialog and resolve with the chosen/typed branch —
 * `undefined` on cancel, matching the other dialogs' convention.
 */
function show(dialog: DialogContext, opts: { currentBranch: string; repo: string }): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => (
        <BranchPickerDialogView
          currentBranch={opts.currentBranch}
          repo={opts.repo}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

export const BranchPickerDialog = {
  show,
}
