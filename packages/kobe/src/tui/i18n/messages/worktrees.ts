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

  hint: {
    legend: "↑↓ nav · d delete · esc close",
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

  hint: {
    legend: "↑↓ 移动 · d 删除 · esc 关闭",
  },
}
