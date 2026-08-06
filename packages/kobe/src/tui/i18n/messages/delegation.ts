export const en = {
  picker: {
    title: "DELEGATE TO TASK",
    primary: "Primary: {task}",
    empty: "No other active, materialized task is available.",
    hint: "enter select · j/k move · esc cancel",
  },
  toast: {
    noPrimary: "Open a primary task before choosing a subagent.",
    noEngine: "The primary task has no engine tab ready for the delegation instructions.",
    linked: "Linked {task} as a subagent.",
    failed: "Couldn't link subagent: {message}",
  },
}

export const zh: typeof en = {
  picker: {
    title: "委派给任务",
    primary: "主任务：{task}",
    empty: "没有其他已就绪的活动任务。",
    hint: "enter 选择 · j/k 移动 · esc 取消",
  },
  toast: {
    noPrimary: "请先打开一个主任务，再选择 subagent。",
    noEngine: "主任务尚无可接收委派说明的引擎标签页。",
    linked: "已将 {task} 链接为 subagent。",
    failed: "无法链接 subagent：{message}",
  },
}
