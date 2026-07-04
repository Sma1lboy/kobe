/**
 * `chat.*` messages — the `kobe chat` native chat pane (experimental,
 * KOBE_TUI=1): opentui-rendered transcript + composer driving headless
 * `claude -p` turns. English is the source of truth; `zh: typeof en`
 * keeps the shapes locked.
 */

export const en = {
  tag: "CHAT",
  working: "working…",
  empty: "No messages yet — type a prompt below.",
  placeholder: "Type a prompt · ⏎ send",
  hint: "⏎ send · ctrl+o expand · pgup/pgdn scroll",
  hintRunning: "esc interrupt · ctrl+o expand · pgup/pgdn scroll",
  interrupted: "interrupted",
  errorPrefix: "error",
  thinking: "thinking",
}

export const zh: typeof en = {
  tag: "对话",
  working: "运行中…",
  empty: "还没有消息 — 在下方输入提示词。",
  placeholder: "输入提示词 · ⏎ 发送",
  hint: "⏎ 发送 · ctrl+o 展开 · pgup/pgdn 滚动",
  hintRunning: "esc 中断 · ctrl+o 展开 · pgup/pgdn 滚动",
  interrupted: "已中断",
  errorPrefix: "错误",
  thinking: "思考",
}
