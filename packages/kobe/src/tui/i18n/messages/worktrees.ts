/**
 * `worktrees.*` messages — the standalone worktree-management page
 * (`kobe worktrees`). English is the source of truth; `zh: typeof en` keeps
 * the shapes locked together.
 */

export const en = {
  title: "Worktrees",
  loading: "Loading worktrees…",
  noProjects: "No local projects known to kobe yet.",
  noWorktrees: "No worktrees.",

  badge: {
    kobeManaged: "kobe",
    dirty: "dirty",
    remoteOn: "on remote",
    remoteOff: "not pushed",
    remoteUnknown: "remote unknown",
  },

  verdict: {
    prOpen: "PR open",
    prMerged: "merged (PR)",
    inMain: "in main",
    prClosed: "PR closed",
    idle: "stale",
  },

  row: {
    detached: "(detached)",
    created: "created {age} ago",
    linkedTask: "task: {title}",
  },

  delete: {
    button: "Delete",
    confirmTitle: "Delete worktree?",
    confirmBody: 'Delete the worktree for "{branch}"? This removes the working directory; the branch itself is kept.',
    forceTitle: "Force delete worktree?",
    forceBody: '"{branch}" has uncommitted or untracked changes that will be PERMANENTLY LOST. Force delete anyway?',
    failed: "Failed to delete worktree: {error}",
  },

  land: {
    button: "Land",
    confirmTitle: "Land branch?",
    confirmBody:
      'Merge "{branch}" into the base repo\'s current branch? A dirty base checkout is refused; conflicts abort with a file list.',
    noTask: "This worktree isn't tracked as a kobe task — nothing to land.",
    conflict: "Land hit conflicts (merge aborted). Resolve by hand: {files}",
    dirtyBase: "The base checkout has uncommitted changes — commit or stash them, then land.",
    failed: "Land failed: {error}",
    done: 'Landed "{branch}" onto {landedOn} ({commit}).',
  },

  hint: {
    legend: "↑↓ nav · d delete · l land · esc close",
  },
}

export const zh: typeof en = {
  title: "工作树",
  loading: "正在加载 worktree…",
  noProjects: "kobe 还没有已知的本地项目。",
  noWorktrees: "没有 worktree。",

  badge: {
    kobeManaged: "kobe",
    dirty: "有改动",
    remoteOn: "已推送",
    remoteOff: "未推送",
    remoteUnknown: "远端未知",
  },

  verdict: {
    prOpen: "PR 评审中",
    prMerged: "已合入 (PR)",
    inMain: "已在主分支",
    prClosed: "PR 已关闭",
    idle: "陈旧",
  },

  row: {
    detached: "(游离状态)",
    created: "{age}前创建",
    linkedTask: "任务：{title}",
  },

  delete: {
    button: "删除",
    confirmTitle: "删除 worktree？",
    confirmBody: '确定删除 "{branch}" 对应的 worktree？工作目录会被移除，分支本身会保留。',
    forceTitle: "强制删除 worktree？",
    forceBody: '"{branch}" 存在未提交或未跟踪的改动，强制删除后将永久丢失。仍要强制删除吗？',
    failed: "删除 worktree 失败：{error}",
  },

  land: {
    button: "合入",
    confirmTitle: "合入分支？",
    confirmBody: '把 "{branch}" 合入基仓库当前分支？基础检出有未提交改动会被拒绝；冲突会中止并给出文件清单。',
    noTask: "该 worktree 未作为 kobe 任务被跟踪——没有可合入的对象。",
    conflict: "合入遇到冲突（已中止）。请手动解决：{files}",
    dirtyBase: "基础检出有未提交改动——请先提交或 stash，再合入。",
    failed: "合入失败：{error}",
    done: '已把 "{branch}" 合入 {landedOn}（{commit}）。',
  },

  hint: {
    legend: "↑↓ 移动 · d 删除 · l 合入 · esc 关闭",
  },
}
