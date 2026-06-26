/**
 * `common.*` messages. English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together. Filled during the TUI i18n migration.
 */

export const en = {
  cancel: "Cancel",
  confirm: "Confirm",
  /** Fallback shown when a pane's render tree throws, replacing the raw
   *  shell the process used to drop to. */
  paneCrash: {
    title: "This pane crashed",
    hint: "Reload it from the Tasks pane (the error was logged to client.log).",
  },
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
  paneCrash: {
    title: "此面板已崩溃",
    hint: "请从任务面板重新加载（错误已记录到 client.log）。",
  },
  rename: {
    defaultTitle: "重命名任务",
    defaultFieldLabel: "名称",
    footerHint: "enter {submitLabel} · esc 取消",
    defaultSubmitLabel: "重命名",
  },
}
