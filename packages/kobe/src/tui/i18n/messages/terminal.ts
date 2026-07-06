/**
 * `terminal.*` messages — the embedded terminal pane (issue #16): the
 * in-process PTY running the task's engine CLI (or a plain worktree
 * shell). English is the source of truth; `zh: typeof en` locks shapes.
 */

export const en = {
  noTask: "(no task — press n to create)",
  exited: "process exited — F5 restarts it",
  scrolledBack: "↑ scrolled {lines}L (ctrl+pgdn to follow)",
  unavailable: {
    shellMissing: "terminal unavailable — configured shell is not available",
    spawnFailed: "terminal unavailable — shell could not start",
  },
  reset: {
    title: "Reset terminal?",
    body: "The running shell will be killed and a fresh one will spawn at the worktree. Any in-flight processes (vim, htop, paused jobs) end immediately.",
  },
}

export const zh: typeof en = {
  noTask: "（无任务 —— 按 n 创建）",
  exited: "进程已退出 —— 按 F5 重启",
  scrolledBack: "↑ 已回滚 {lines} 行（ctrl+pgdn 回到底部）",
  unavailable: {
    shellMissing: "终端不可用 —— 配置的 shell 不存在",
    spawnFailed: "终端不可用 —— shell 启动失败",
  },
  reset: {
    title: "重置终端？",
    body: "正在运行的 shell 会被杀掉并在 worktree 重新启动，进行中的进程（vim、htop、暂停的任务）会立即结束。",
  },
}
