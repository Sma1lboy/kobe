/** @jsxImportSource @opentui/react */

import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { PickerList, labelStyle } from "./picker-list"
import type { NewTaskVm } from "./view-model"

export function AdoptTab({ vm }: { vm: NewTaskVm }) {
  const { theme } = useTheme()
  const t = useT()

  const rows = vm.adoptVisible.map((w) => {
    const tags = [w.dirty ? "dirty" : "", w.kobeManaged ? "" : "external"].filter(Boolean).join(",")
    return {
      key: w.path,
      body: `${vm.adoptSelected.has(w.path) ? "[x] " : "[ ] "}${w.branch}${tags ? `  (${tags})` : ""}`,
      accent: vm.adoptSelected.has(w.path),
    }
  })

  return (
    <>
      <box gap={0}>
        <text {...labelStyle(theme, vm.field, "adoptFilter")}>{t("newTask.field.adoptFilter")}</text>
        <input
          value={vm.adoptFilter}
          placeholder={t("newTask.placeholder.adoptFilter")}
          focused={vm.field === "adoptFilter"}
          onInput={(v: string) => vm.setAdoptFilterText(v)}
          onSubmit={() => vm.toggleAdoptCursor()}
        />
      </box>
      <box paddingLeft={2}>
        <text fg={theme.textMuted} wrapMode="none">
          {t("newTask.adopt.repoLine", { path: vm.expandedRepo || t("newTask.adopt.repoNone") })}
        </text>
      </box>
      {vm.adoptLoading ? (
        <box paddingLeft={2}>
          <text fg={theme.textMuted} wrapMode="none">
            {t("newTask.hint.scanningWorktrees")}
          </text>
        </box>
      ) : null}
      {!vm.adoptLoading && vm.adoptList.length === 0 ? (
        <box paddingLeft={2}>
          <text fg={theme.textMuted} wrapMode="none">
            {vm.adoptDiscoveredCount === 0 ? t("newTask.adopt.noUnlinked") : t("newTask.adopt.noMatch")}
          </text>
        </box>
      ) : null}
      {vm.adoptList.length > 0 ? (
        <PickerList
          window={vm.adoptWindow}
          cursor={vm.adoptCursor}
          rows={rows}
          onPick={vm.pickAdoptAt}
          footer={
            <text fg={theme.textMuted} wrapMode="none">
              {vm.adoptSelected.size > 0
                ? t("newTask.adopt.hintSelected", { count: vm.adoptSelected.size })
                : t("newTask.adopt.hintDefault")}
            </text>
          }
        />
      ) : null}
    </>
  )
}
