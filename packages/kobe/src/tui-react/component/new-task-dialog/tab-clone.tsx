/** @jsxImportSource @opentui/react */
/**
 * Clone ("For New Repo") tab of the React new-task dialog (issue #15,
 * G3W2) — git URL, parent dir (with the same drill-down picker the
 * existing tab uses), auto-derived folder name, base branch. The async
 * clone runs in the view-model; this file is JSX only.
 */

import { DEFAULT_BASE_REF } from "../../../tui/lib/git-snapshot"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { PickerList, labelStyle } from "./picker-list"
import type { NewTaskVm } from "./view-model"

export function CloneTab({ vm }: { vm: NewTaskVm }) {
  const { theme } = useTheme()
  const t = useT()

  const parentRows = vm.cloneParentWindow.items.map((name, i) => ({
    key: `${vm.cloneParentWindow.start + i}:${name}`,
    body: `${name}/`,
  }))

  return (
    <>
      <box gap={0}>
        <text {...labelStyle(theme, vm.field, "cloneUrl")}>{t("newTask.field.gitUrl")}</text>
        <input
          value={vm.cloneUrl}
          placeholder="https://github.com/user/repo.git"
          focused={vm.field === "cloneUrl"}
          onInput={(v: string) => vm.setCloneUrlText(v)}
          onSubmit={() => {
            if (!vm.cloneUrl.trim()) return
            vm.setField("cloneParent")
          }}
        />
      </box>
      <box gap={0}>
        <text {...labelStyle(theme, vm.field, "cloneParent")}>{t("newTask.field.parentDir")}</text>
        <input
          value={vm.cloneParent}
          placeholder="~/"
          focused={vm.field === "cloneParent"}
          onInput={(v: string) => vm.setCloneParentText(v)}
          onSubmit={() => vm.onCloneParentSubmit()}
        />
      </box>
      {/* Persistence hint — this field remembers its last value across
          dialog opens (kv `lastClonedRepoParent`). */}
      {vm.field === "cloneParent" ? (
        <box paddingLeft={2}>
          <text fg={theme.textMuted} wrapMode="none">
            {t("newTask.hint.remembered")}
          </text>
        </box>
      ) : null}
      {vm.field === "cloneParent" && vm.cloneParentFiltered.length > 0 && !vm.cloneParentPicked ? (
        <PickerList
          window={vm.cloneParentWindow}
          cursor={vm.cloneParentCursor}
          rows={parentRows}
          onPick={vm.selectCloneParentAt}
        />
      ) : null}
      <box gap={0}>
        <text {...labelStyle(theme, vm.field, "cloneFolder")}>{t("newTask.field.folderName")}</text>
        <input
          value={vm.cloneFolder}
          placeholder={t("newTask.placeholder.folderName")}
          focused={vm.field === "cloneFolder"}
          onInput={(v: string) => vm.setCloneFolderText(v)}
          onSubmit={() => vm.setField("cloneBaseRef")}
        />
      </box>
      <box gap={0}>
        <text {...labelStyle(theme, vm.field, "cloneBaseRef")}>{t("newTask.field.baseBranch")}</text>
        <input
          value={vm.cloneBaseRef}
          placeholder={DEFAULT_BASE_REF}
          focused={vm.field === "cloneBaseRef"}
          onInput={(v: string) => vm.setCloneBaseRefText(v)}
          // Last field on the tab — Enter kicks off the clone + create.
          onSubmit={() => void vm.commitClone()}
        />
      </box>
      {vm.cloneInFlight ? (
        <box gap={0} paddingLeft={2}>
          <text fg={theme.textMuted} wrapMode="none">
            {vm.cloneProgress || t("newTask.clone.progressFallback")}
          </text>
        </box>
      ) : null}
    </>
  )
}
