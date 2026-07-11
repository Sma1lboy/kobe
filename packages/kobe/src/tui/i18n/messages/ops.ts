/**
 * `ops.*` messages. English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together. Filled during the TUI i18n migration.
 */

export const en = {
  preview: {
    diffVsHead: "diff vs HEAD",
    diffVsBase: "diff vs {base}",
    file: "file",
    closeHint: "· q to close",
    loading: "loading…",
  },
}

export const zh: typeof en = {
  preview: {
    diffVsHead: "与 HEAD 对比",
    diffVsBase: "与 {base} 对比",
    file: "文件",
    closeHint: "· q 关闭",
    loading: "加载中…",
  },
}
