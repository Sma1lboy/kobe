/** @jsxImportSource @opentui/react */
/**
 * Existing tab of the React new-task dialog (issue #15, G3W2) — pick an
 * existing local repo path + base branch. Direct port of the Solid
 * shell's existing-tab body: unified free-text repo input with the
 * saved/browse smart dropdown, branch picker that augments the input.
 * All behavior lives in the view-model; this file is JSX only.
 */

import { DEFAULT_BASE_REF } from "../../../tui/lib/git-snapshot"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { PickerList, labelStyle } from "./picker-list"
import type { NewTaskVm } from "./view-model"

export function ExistingTab({ vm }: { vm: NewTaskVm }) {
  const { theme } = useTheme()
  const t = useT()

  const repoRows = vm.activeWindow.items.map((name, i) => {
    const isCurrentDir = vm.mode === "saved" && name === vm.defaultRepo
    const suffix = vm.mode === "browse" ? "/" : ""
    const tag = isCurrentDir ? `  ${t("newTask.hint.currentDir")}` : ""
    return {
      key: `${vm.activeWindow.start + i}:${name}`,
      body: `${name}${suffix}${tag}`,
      accent: vm.mode === "saved" && vm.repo.trim() === name,
    }
  })

  const branchRows = vm.branchWindow.items.map((name, i) => ({
    key: `${vm.branchWindow.start + i}:${name}`,
    body: name,
    accent: vm.baseRef.trim() === name,
  }))

  return (
    <>
      <box gap={0}>
        <text {...labelStyle(theme, vm.field, "repo")}>{t("newTask.field.repo")}</text>
        <input
          value={vm.repo}
          placeholder={vm.defaultRepo}
          focused={vm.field === "repo"}
          onMouseUp={() => vm.setField("repo")}
          onInput={(v: string) => vm.setRepoText(v)}
          // Every Enter routes through onRepoSubmit — it handles the
          // empty-input pick-first case too.
          onSubmit={() => vm.onRepoSubmit()}
        />
      </box>
      {vm.field === "repo" && vm.activeList.length > 0 && !vm.repoPicked ? (
        <PickerList window={vm.activeWindow} cursor={vm.repoCursor} rows={repoRows} onPick={vm.selectRepoAt} />
      ) : null}
      <box gap={0}>
        <text {...labelStyle(theme, vm.field, "baseRef")}>{t("newTask.field.fromBranch")}</text>
        <input
          value={vm.baseRef}
          placeholder={DEFAULT_BASE_REF}
          focused={vm.field === "baseRef"}
          onMouseUp={() => vm.setField("baseRef")}
          onInput={(v: string) => vm.setBaseRefText(v)}
          // Last field on the tab — Enter resolves the highlighted branch
          // and creates straight away.
          onSubmit={() => vm.onBaseRefSubmit()}
        />
      </box>
      {vm.field === "baseRef" && vm.branchFiltered.length === 0 && vm.submitError == null ? (
        <box gap={0} paddingLeft={2} paddingBottom={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {vm.branches.length === 0 ? t("newTask.hint.noBranchesFound") : t("newTask.hint.noMatchBranch")}
          </text>
        </box>
      ) : null}
      {vm.field === "baseRef" && vm.branchFiltered.length > 0 ? (
        <PickerList
          window={vm.branchWindow}
          cursor={vm.branchCursor}
          rows={branchRows}
          onPick={vm.pickBranchAt}
          paddingBottom={1}
        />
      ) : null}
    </>
  )
}
