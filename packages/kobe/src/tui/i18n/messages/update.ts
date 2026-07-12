/**
 * `update.*` messages. English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together. Filled during the TUI i18n migration.
 */

export const en = {
  pageTitle: "KOBE UPDATE",
  current: "current",
  latest: "latest",
  releaseUrlUnavailable: "release URL unavailable",
  statusReleaseOpened: "Opened release page in your browser.",
  statusReleaseError: "Could not open release URL.",
  statusRunningUpdater: "Closing the TUI and running the updater in this terminal...",
  loadingNotes: "Loading release notes...",
  notesUnavailable: "Release notes are unavailable. Use Open release to view the GitHub release page.",
  changesSectionHeader: "── changes from v{from} to v{to} ──",
  updateComplete: "kobe update complete. Relaunch kobe to use the new version.",
  updateFailed: "kobe update failed with exit code {code}.",
  pressAnyKey: "Press any key to close this update window.",
  actions: {
    updateNow: "Update now",
    openRelease: "Open release",
    close: "Close",
    closeDetail: "return to the workspace",
  },
  skew: {
    title: "⚠ DAEMON OUT OF DATE",
    olderBuild: "an older build",
    hint: "daemon is {daemon} — you launched v{clientVersion}. Run `kobe daemon restart`, then relaunch kobe",
  },
}

export const zh: typeof en = {
  pageTitle: "KOBE 更新",
  current: "当前",
  latest: "最新",
  releaseUrlUnavailable: "发布链接不可用",
  statusReleaseOpened: "已在浏览器中打开发布说明页面。",
  statusReleaseError: "无法打开发布链接。",
  statusRunningUpdater: "正在关闭 TUI，并在当前终端中运行更新程序……",
  loadingNotes: "正在加载发布说明……",
  notesUnavailable: "发布说明不可用。请使用「打开发布页」查看 GitHub 发布页面。",
  changesSectionHeader: "── v{from} 至 v{to} 的变更 ──",
  updateComplete: "kobe 更新完成。请重新启动 kobe 以使用新版本。",
  updateFailed: "kobe 更新失败，退出码为 {code}。",
  pressAnyKey: "按任意键关闭此更新窗口。",
  actions: {
    updateNow: "立即更新",
    openRelease: "打开发布页",
    close: "关闭",
    closeDetail: "返回工作区",
  },
  skew: {
    title: "⚠ DAEMON 版本不一致",
    olderBuild: "旧版本构建",
    hint: "daemon 运行的是 {daemon}，而你启动的是 v{clientVersion}。请运行 `kobe daemon restart`，然后重新启动 kobe",
  },
}
