/** `taskMessaging.*` messages for the stateless `prefix+@` Task picker. */

export const en = {
  picker: {
    title: "MESSAGE A TASK",
    current: "From · {task}",
    empty: "No other available tasks",
    hint: "j/k move · enter choose · esc cancel",
  },
  toast: {
    noCurrent: "Select a task before choosing a message target.",
    noEngine: "The current task has no engine tab ready for the contact instructions.",
    ready: "Added {task}'s address to the current chat",
  },
}

export const zh: typeof en = {
  picker: {
    title: "选择消息目标",
    current: "发送方 · {task}",
    empty: "没有其他可用任务",
    hint: "j/k 移动 · enter 选择 · esc 取消",
  },
  toast: {
    noCurrent: "请先选择一个任务，再选择消息目标。",
    noEngine: "当前任务没有可接收通讯说明的引擎标签页。",
    ready: "已将 {task} 的地址交给当前聊天",
  },
}
