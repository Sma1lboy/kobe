/**
 * `settings.*` messages — the Settings dialog (sidebar, footer, every
 * section). English is the source of truth; `zh` mirrors its shape exactly
 * (`zh: typeof en`). One namespace per surface keeps parallel translation
 * work conflict-free — see `../catalog.ts` for how the namespaces compose.
 */

export const en = {
  title: "Settings",
  esc: "esc",
  nav: {
    default: "j/k pick · h/l switch level · enter activate · esc close",
    feedback: "tab next field · enter sends on Send · esc close",
  },
  sections: {
    general: "General",
    engines: "Engines",
    accounts: "Accounts",
    keys: "Keybindings",
    feedback: "Feedback",
    dev: "Dev",
  },
  general: {
    theme: "Theme",
    themeHint: "l to enter list · j/k to highlight · enter to apply",
    language: "Language",
    languageHint: "Display language for kobe's UI. l to enter list · j/k to highlight · enter to apply.",
    transparent: "Transparent background",
    transparentHint: "Drops the renderer's bg fill so the host terminal shows through. `t` toggles.",
    on: "[x] on",
    off: "[ ] off",
    focusAccent: "Focus accent",
    focusAccentHint: "Color of focused pane title, ▌ marker, and split borders.",
    accentPrimary: "Primary (brand accent)",
    accentSuccess: "Success (legacy green)",
    accentInfo: "Info (cool blue)",
    reducedMotion: "Reduced motion",
    reducedMotionHint:
      "Calms chrome animations: the running-task spinner becomes a slow pulsing dot, and the toast slide-in, materializing sweep, and tab-complete flash turn off.",
    appearance: "Appearance",
    appearanceHint:
      "How split panes draw: a full box frame around every pane, or a single tmux-style divider line between neighbors.",
    splitBox: "Box frames",
    splitLine: "Divider line",
    notifications: "Notifications",
    notificationsHint:
      "Fired when a background chat tab finishes or pauses on an approval. Toast = bottom-right popup; Sound = terminal bell + chime. Tab-chip unread dot is always on.",
    toast: "Toast",
    sound: "Sound",
    zen: "Zen mode",
    zenHint:
      "The `zen` chip (above the file list) and `prefix`+space collapse the ChatTab to the engine pane — hiding the file and terminal panes. Keep this on to leave the Tasks rail visible so you can always get back out.",
    zenKeepTasks: "Keep Tasks pane in zen mode",
    surface: "Settings page",
    surfaceHint:
      "Where Settings and the other full dialogs (new task, rename) open. ChatTab = a dedicated full-window page alongside the engine tabs; Task panel = an overlay inside the left Tasks pane. enter to pick.",
    surfaceChattab: "ChatTab (separate page)",
    surfaceTaskpanel: "Task panel (in-pane overlay)",
    editor: "Editor",
    editorHint:
      "What `e` opens a file with in the file tree (enter stays the read-only preview). `auto` (default) follows $VISUAL / $EDITOR, else auto-detects nvim / vim / emacs / nano. enter on the row below cycles auto / vim / nvim / nano / emacs / custom; if the editor isn't installed it falls back to the preview.",
    editorRow: "editor: < {kind} >  (enter to change)",
    editorCustom: "custom: {cmd}",
    editorCustomUnset: "(unset — enter to edit)",
    worktree: "Worktree location",
    worktreeHint:
      "Where new task worktrees are created. `next to project` keeps them beside each repo; custom takes any path (`~`, relative, or a leading `$project_dir`). New tasks only.",
    worktreeBase: "location: < {kind} >  (enter switches)",
    worktreeKindDefault: "default ~/.kobe/worktrees",
    worktreeKindNext: "next to project",
    worktreeKindCustom: "custom",
    worktreeCustom: "custom: {path}",
    worktreeCustomUnset: "(unset — enter to edit)",
    worktreeBaseTitle: "Custom worktree location (blank = default; $project_dir = project root)",
    worktreeBaseField: "path",
  },
  engines: {
    title: "Launch command",
    hint: "The command each engine's task pane runs. Override a built-in when your binary isn't on PATH as `claude` / `codex` (e.g. it's `cl`) or to pass default flags, or add your own engine. ● = global default engine (per-project picks, e.g. Ctrl+Shift+T, override it). enter edit command · r rename · x reset/remove · d set default.",
    defaultTag: "  (default)",
    customTag: "  (custom)",
    addEngine: "+ Add engine",
  },
  accounts: {
    title: "Accounts",
    hint: "Read-only view of locally-detected engine accounts. Login flows land here later.",
    checking: "Checking…",
    notLoggedIn: "○ Not logged in",
    loggedIn: "● Logged in: {email}",
    apiKeyConfigured: "● API key configured",
    chatgptLogin: "● ChatGPT login: {email}",
    tokenConfigured: "● Token configured ({source})",
    copilotDetected: "● Copilot login detected",
  },
  keybindings: {
    title: "Keybindings",
    hint: "Rebind chords by editing the YAML below, then restart kobe (or respawn the pane). Press F1 anywhere for the live keymap with every binding id.",
    configFile: "Config file",
    notCreated: "  (not created yet)",
    example: "Example",
    overridesApplied: "Overrides applied",
    none: "none",
    warnings: "Warnings",
  },
  feedback: {
    title: "Feedback",
    hint: "Sends a GitHub Discussion to the kobe repo through `gh`. Requires `gh auth login`; category defaults to Feedback.",
    titleLabel: "title",
    titlePlaceholder: "Short summary",
    descriptionLabel: "description",
    descriptionPlaceholder: "What happened? (enter for a new line · tab to Send)",
    send: "[enter] Send to GitHub Discussions",
  },
  dev: {
    reset: "Reset UI state",
    resetHint:
      "Clears ~/.config/kobe/state.json and ~/.kobe/tasks.json, then quits kobe — relaunch to start fresh. Working session / Archive lists, pane sizes, theme, model picks all reset. Worktrees on disk and Claude Code session history are not touched.",
    resetButton: "[enter] Reset",
    restart: "Restart backend",
    restartHint:
      "Stops the kobe daemon and quits this kobe window so the next launch spawns a fresh daemon — picks up daemon / orchestrator / engine edits without a process kill. Other attached kobe windows will lose their connection too.",
    restartButton: "[enter] Restart",
    doctorHint:
      "Daemon wedged or unresponsive? From a shell, run `kobe doctor` to diagnose, or `kobe reset` to stop the daemon + kill sessions (keeps your tasks). Use `kobe reset --hard` only to also wipe the task index + UI state.",
    experimental: "Experimental",
    remoteHint:
      "Remote projects (SSH): register a project whose git worktrees + engine run on another host over SSH, driven from this local kobe. Unfinished — file/diff panes still degrade for remote. Enables `kobe add --remote`.",
    remoteOn: "[x] Remote projects (on)",
    remoteOff: "[ ] Remote projects (off)",
    autoStatusHint:
      "Auto status flow: a backlog task moves to in_progress when its engine starts a turn, and new claude sessions get a system-prompt note telling the agent to set in_review itself when the work is done. Never touches done/canceled.",
    autoStatusOn: "[x] Auto status flow (on)",
    autoStatusOff: "[ ] Auto status flow (off)",
    dispatcherHint:
      "Field-notes dispatcher: task sessions file one-line gotchas (`kobe api note`), the daemon forwards each to the repo's main session, and that session relays them to the in-flight tasks that benefit (`kobe api dispatch`). Web-hosted sessions receive the relays today.",
    dispatcherOn: "[x] Field-notes dispatcher (on)",
    dispatcherOff: "[ ] Field-notes dispatcher (off)",
    archivedHistoryHint:
      "Archived history preview (beta): opening an archived task shows a read-only `kobe history` pane (session selector + transcript) in the engine slot instead of relaunching the engine. Its transcript survives worktree removal because the engine store is keyed by the worktree path. Shared with the web dashboard.",
    archivedHistoryOn: "[x] Archived history preview (on)",
    archivedHistoryOff: "[ ] Archived history preview (off)",
  },
}

export const zh: typeof en = {
  title: "设置",
  esc: "esc",
  nav: {
    default: "j/k 选择 · h/l 切换层级 · enter 确认 · esc 关闭",
    feedback: "tab 下一项 · enter 在发送项发送 · esc 关闭",
  },
  sections: {
    general: "通用",
    engines: "引擎",
    accounts: "账户",
    keys: "快捷键",
    feedback: "反馈",
    dev: "开发",
  },
  general: {
    theme: "主题",
    themeHint: "l 进入列表 · j/k 高亮 · enter 应用",
    language: "语言",
    languageHint: "kobe 界面的显示语言。l 进入列表 · j/k 高亮 · enter 应用。",
    transparent: "透明背景",
    transparentHint: "去掉渲染器的背景填充，让宿主终端透出来。按 `t` 切换。",
    on: "[x] 开",
    off: "[ ] 关",
    focusAccent: "聚焦强调色",
    focusAccentHint: "聚焦面板标题、▌ 标记和分隔边框的颜色。",
    accentPrimary: "主色（品牌强调色）",
    accentSuccess: "成功色（传统绿）",
    accentInfo: "信息色（冷蓝）",
    appearance: "外观",
    appearanceHint: "分屏面板的描边方式:每个面板一个完整方框,或 tmux 风格的单线分隔。",
    splitBox: "方框边框",
    splitLine: "单线分隔",
    reducedMotion: "减弱动效",
    reducedMotionHint:
      "让界面动效安静下来：运行中任务的 spinner 变为缓慢明暗脉冲点，Toast 滑入、worktree 创建扫动条和标签完成闪烁全部关闭。",
    notifications: "通知",
    notificationsHint:
      "后台聊天页完成或在审批处暂停时触发。Toast = 右下角弹窗；Sound = 终端响铃 + 提示音。标签上的未读圆点始终开启。",
    toast: "Toast 弹窗",
    sound: "声音",
    zen: "禅模式",
    zenHint:
      "`zen` 标记（文件列表上方）和 `prefix`+空格 会把 ChatTab 收起到引擎面板——隐藏文件与终端面板。保持开启可让 Tasks 侧栏始终可见，方便随时退出。",
    zenKeepTasks: "禅模式下保留 Tasks 面板",
    surface: "设置页面",
    surfaceHint:
      "设置及其他完整对话框（新建任务、重命名）的打开位置。ChatTab = 与引擎标签并列的独立整窗页面；Task panel = 左侧 Tasks 面板内的浮层。enter 选择。",
    surfaceChattab: "ChatTab（独立页面）",
    surfaceTaskpanel: "Task panel（面板内浮层）",
    editor: "编辑器",
    editorHint:
      "文件树里按 `e` 用什么打开文件（enter 仍是只读预览）。`auto`（默认）跟随 $VISUAL / $EDITOR，否则自动探测 nvim / vim / emacs / nano。在下方一行按 enter 在 auto / vim / nvim / nano / emacs / custom 间循环；编辑器未安装时回退到预览。",
    editorRow: "编辑器: < {kind} >  (enter 切换)",
    editorCustom: "自定义: {cmd}",
    editorCustomUnset: "(未设置 — enter 编辑)",
    worktree: "工作树位置",
    worktreeHint:
      "新任务工作树的创建位置。「项目旁边」= 紧挨各自仓库存放；自定义可填任意路径（`~`、相对路径或以 `$project_dir` 开头）。仅对新任务生效。",
    worktreeBase: "位置: < {kind} >  (enter 切换)",
    worktreeKindDefault: "默认 ~/.kobe/worktrees",
    worktreeKindNext: "项目旁边",
    worktreeKindCustom: "自定义",
    worktreeCustom: "自定义: {path}",
    worktreeCustomUnset: "(未设置 — enter 编辑)",
    worktreeBaseTitle: "自定义工作树位置（留空 = 默认；$project_dir = 项目根目录）",
    worktreeBaseField: "路径",
  },
  engines: {
    title: "启动命令",
    hint: "每个引擎的任务面板运行的命令。当二进制文件不在 PATH 上的 `claude` / `codex` 名下（比如叫 `cl`）、要传默认参数，或要添加自己的引擎时，可覆盖内置项。● = 全局默认引擎（各项目自己的选择会覆盖它，如 Ctrl+Shift+T）。enter 编辑命令 · r 重命名 · x 重置/移除 · d 设为默认。",
    defaultTag: "  (默认)",
    customTag: "  (自定义)",
    addEngine: "+ 添加引擎",
  },
  accounts: {
    title: "账户",
    hint: "本地探测到的引擎账户的只读视图。登录流程稍后会接入这里。",
    checking: "检查中…",
    notLoggedIn: "○ 未登录",
    loggedIn: "● 已登录: {email}",
    apiKeyConfigured: "● 已配置 API key",
    chatgptLogin: "● ChatGPT 登录: {email}",
    tokenConfigured: "● 已配置 Token ({source})",
    copilotDetected: "● 检测到 Copilot 登录",
  },
  keybindings: {
    title: "快捷键",
    hint: "编辑下面的 YAML 来重绑定按键，然后重启 kobe（或重建面板）。任意位置按 F1 查看带每个绑定 id 的实时键位表。",
    configFile: "配置文件",
    notCreated: "  (尚未创建)",
    example: "示例",
    overridesApplied: "已应用的覆盖",
    none: "无",
    warnings: "警告",
  },
  feedback: {
    title: "反馈",
    hint: "通过 `gh` 向 kobe 仓库发一条 GitHub Discussion。需要 `gh auth login`；分类默认为 Feedback。",
    titleLabel: "标题",
    titlePlaceholder: "简短概括",
    descriptionLabel: "描述",
    descriptionPlaceholder: "发生了什么？(enter 换行 · tab 跳到发送)",
    send: "[enter] 发送到 GitHub Discussions",
  },
  dev: {
    reset: "重置 UI 状态",
    resetHint:
      "清空 ~/.config/kobe/state.json 和 ~/.kobe/tasks.json，然后退出 kobe——重新启动即可从头开始。工作会话 / 归档列表、面板尺寸、主题、模型选择都会重置。磁盘上的 worktree 和 Claude Code 会话历史不受影响。",
    resetButton: "[enter] 重置",
    restart: "重启后端",
    restartHint:
      "停止 kobe daemon 并退出当前 kobe 窗口，下次启动会拉起一个全新的 daemon——无需杀进程即可应用 daemon / orchestrator / engine 的改动。其他已连接的 kobe 窗口也会断开连接。",
    restartButton: "[enter] 重启",
    doctorHint:
      "daemon 卡住或无响应？在 shell 里运行 `kobe doctor` 诊断，或 `kobe reset` 停止 daemon + 杀掉会话（保留你的任务）。只有要同时清空任务索引 + UI 状态时才用 `kobe reset --hard`。",
    experimental: "实验性",
    remoteHint:
      "远程项目（SSH）：注册一个 git worktree + 引擎都通过 SSH 跑在另一台主机上、由本地 kobe 驱动的项目。尚未完成——文件/diff 面板对远程仍会降级。启用 `kobe add --remote`。",
    remoteOn: "[x] 远程项目 (开)",
    remoteOff: "[ ] 远程项目 (关)",
    autoStatusHint:
      "自动状态流转：backlog 任务在其引擎开始一轮时移到 in_progress，新的 claude 会话会拿到一条系统提示，告诉 agent 完成后自行设为 in_review。绝不触碰 done/canceled。",
    autoStatusOn: "[x] 自动状态流转 (开)",
    autoStatusOff: "[ ] 自动状态流转 (关)",
    dispatcherHint:
      "现场笔记调度器：任务会话提交一行经验（`kobe api note`），daemon 将每条转发给仓库的主会话，主会话再把它们转达给能受益的进行中任务（`kobe api dispatch`）。目前由 Web 托管的会话会收到转达。",
    dispatcherOn: "[x] 现场笔记调度器 (开)",
    dispatcherOff: "[ ] 现场笔记调度器 (关)",
    archivedHistoryHint:
      "归档历史预览（beta）：打开已归档的任务时，引擎位置改为只读的 `kobe history` 面板（会话选择器 + 对话记录），而不是重新启动引擎。引擎记录按 worktree 路径存储，所以 worktree 被删除后历史仍然可读。与 Web 仪表盘共用同一开关。",
    archivedHistoryOn: "[x] 归档历史预览 (开)",
    archivedHistoryOff: "[ ] 归档历史预览 (关)",
  },
}
