/**
 * `common.*` messages. English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together. Filled during the TUI i18n migration.
 */

export const en = {
  cancel: "Cancel",
  confirm: "Confirm",
  rename: {
    defaultTitle: "Rename task",
    defaultFieldLabel: "title",
    /** Footer hint shown at the bottom of the rename dialog.
     *  `{submitLabel}` is interpolated with the verb (e.g. "rename"). */
    footerHint: "enter {submitLabel} · esc cancel",
    defaultSubmitLabel: "rename",
  },
}

export const zh: typeof en = {
  cancel: "取消",
  confirm: "确认",
  rename: {
    defaultTitle: "重命名任务",
    defaultFieldLabel: "名称",
    footerHint: "enter {submitLabel} · esc 取消",
    defaultSubmitLabel: "重命名",
  },
}
