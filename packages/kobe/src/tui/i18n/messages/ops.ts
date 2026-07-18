/**
 * `ops.*` messages. English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together. Filled during the TUI i18n migration.
 */

export const en = {
  preview: {
    diffVsHead: "diff vs HEAD",
    diffVsBase: "diff vs {base}",
    file: "file",
    image: "image",
    binary: "binary file",
    closeHint: "· q to close",
    loading: "loading…",
    noTextPreview: "no text preview",
    openHint: "o open in system viewer",
  },
}

export const zh: typeof en = {
  preview: {
    diffVsHead: "与 HEAD 对比",
    diffVsBase: "与 {base} 对比",
    file: "文件",
    image: "图片",
    binary: "二进制文件",
    closeHint: "· q 关闭",
    loading: "加载中…",
    noTextPreview: "无文本预览",
    openHint: "o 用系统查看器打开",
  },
}
