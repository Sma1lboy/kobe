/** `channels.*` messages — cross-task native chat channels. */

export const en = {
  section: "CHANNELS",
  picker: {
    title: "Connect this chat",
    source: "FROM  {task}",
    hint: "j/k choose · enter connect · esc cancel",
    empty: "No other active task can be connected",
  },
  workspace: {
    label: "AGENT CHANNEL",
    missing: "One of this channel's endpoint tasks is unavailable",
  },
  toast: {
    unsupported: "{engine} cannot fork a native chat session",
    noSession: "{task} has no conversation to fork yet",
    engineOnly: "Select an engine chat tab before connecting",
    failed: "Could not connect chats: {message}",
  },
}

export const zh: typeof en = {
  section: "频道",
  picker: {
    title: "连接当前对话",
    source: "发起  {task}",
    hint: "j/k 选择 · enter 连接 · esc 取消",
    empty: "没有其他可连接的活跃任务",
  },
  workspace: {
    label: "AGENT 频道",
    missing: "该频道的某个端点任务已不可用",
  },
  toast: {
    unsupported: "{engine} 不支持原生 fork 对话",
    noSession: "{task} 还没有可 fork 的对话",
    engineOnly: "请先选中一个引擎对话标签页",
    failed: "连接对话失败：{message}",
  },
}
