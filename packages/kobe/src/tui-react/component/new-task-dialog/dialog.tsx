/** @jsxImportSource @opentui/react */

import { TextAttributes } from "@opentui/core"
import type { DialogTab } from "../../../tui/component/new-task-dialog/state"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { labelStyle } from "./picker-list"
import { AdoptTab } from "./tab-adopt"
import { CloneTab } from "./tab-clone"
import { ExistingTab } from "./tab-existing"
import { type NewTaskDialogProps, useNewTaskViewModel } from "./view-model"

export type { NewTaskDialogProps } from "./view-model"

const TAB_ORDER: readonly DialogTab[] = ["existing", "clone", "adopt"]

export function NewTaskDialogView(props: NewTaskDialogProps) {
  const { theme } = useTheme()
  const t = useT()
  const vm = useNewTaskViewModel(props)

  const tabLabel: Record<DialogTab, string> = {
    existing: t("newTask.tabs.existing"),
    clone: t("newTask.tabs.clone"),
    adopt: t("newTask.tabs.adopt"),
  }
  const tabsFocused = vm.field === "tabs"
  const selectedAttrs = (selected: boolean, focused: boolean) =>
    selected ? (focused ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.BOLD) : undefined

  return (
    <box paddingLeft={2} paddingRight={2} gap={0}>
      <box flexDirection="row">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("newTask.title")}
        </text>
      </box>
      <box gap={1} paddingTop={1} paddingBottom={1}>
        {}
        <box flexDirection="row" gap={2}>
          {TAB_ORDER.map((tabId) => {
            const active = vm.tab === tabId
            return (
              <text
                key={tabId}
                fg={active ? theme.primary : theme.textMuted}
                attributes={selectedAttrs(active, tabsFocused)}
                onMouseUp={() => vm.switchToTab(tabId)}
              >
                {active ? `▸ ${tabLabel[tabId]}` : `  ${tabLabel[tabId]}`}
              </text>
            )
          })}
        </box>
        {}
        <box gap={0}>
          <text {...labelStyle(theme, vm.field, "engine")}>{t("newTask.field.engine")}</text>
          <box flexDirection="row" gap={2}>
            {vm.vendors.map((v) => {
              const selected = vm.vendor === v
              return (
                <text
                  key={v}
                  fg={selected ? theme.primary : theme.textMuted}
                  attributes={selected ? TextAttributes.BOLD : undefined}
                  onMouseUp={() => vm.setVendor(v)}
                >
                  {selected ? "▸ " : "  "}
                  {v}
                </text>
              )
            })}
            <box flexGrow={1} />
            <text fg={theme.textMuted}>{t("newTask.hint.engineCycle")}</text>
          </box>
        </box>
        {vm.tab === "existing" ? <ExistingTab vm={vm} /> : null}
        {vm.tab === "clone" ? <CloneTab vm={vm} /> : null}
        {vm.tab === "adopt" ? <AdoptTab vm={vm} /> : null}
        {vm.submitError ? (
          <text fg={theme.error} wrapMode="word">
            ※ {vm.submitError}
          </text>
        ) : null}
      </box>
      {}
      <box flexDirection="row" justifyContent="space-between" alignItems="center" paddingTop={1} paddingBottom={1}>
        <text fg={theme.textMuted}>{t("newTask.hint.legend")}</text>
        <text
          fg={vm.field === "confirm" ? theme.primary : theme.text}
          attributes={vm.field === "confirm" ? TextAttributes.BOLD : undefined}
          onMouseUp={() => vm.commit()}
        >
          {vm.cloneInFlight
            ? t("newTask.button.cloning")
            : vm.field === "confirm"
              ? t("newTask.button.createFocused")
              : t("newTask.button.create")}
        </text>
      </box>
    </box>
  )
}
