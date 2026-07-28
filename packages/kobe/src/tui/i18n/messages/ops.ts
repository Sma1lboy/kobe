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
    review: {
      noteDialogTitle: "Review note — {location}",
      noteFieldLabel: "note",
      noteSubmitLabel: "add note",
      notePlaceholder: "what should the agent change here?",
      count: "{total} notes · {unsent} unsent",
      keysHint: "j/k line · v range · c note · s send",
    },
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
    review: {
      noteDialogTitle: "评审备注 — {location}",
      noteFieldLabel: "备注",
      noteSubmitLabel: "添加备注",
      notePlaceholder: "希望 agent 在这里改什么？",
      count: "{total} 条备注 · {unsent} 条未发送",
      keysHint: "j/k 行 · v 范围 · c 备注 · s 发送",
    },
  },
}
