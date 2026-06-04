kobe 发布同步（2026-06-04）

今晚连发四个补丁版本（0.7.2、0.7.3、0.7.4、0.7.5），全部已发布到 npm，当前 latest 为 0.7.5。每个版本构建 darwin-arm64、linux-x64、linux-arm64 三个独立二进制（已停止支持 macOS Intel）。升级方式：npm i -g @sma1lboy/kobe@0.7.5，然后执行 kobe daemon restart，再执行 kobe reload。

0.7.2 —— 修复任务面板创建/删除不同步、新增 kobe reload、补齐日志

一，项目行卡在 working 的修复。main（项目根）任务没有会话生命周期去维护状态，旧版本每轮结束会翻成 done、加载时又被自愈翻回 in_progress，导致项目永久显示 working。现在 main 行加载时归零为 backlog，且只有真有活跃引擎时才显示 working。

二，同步漂移收拢。Tasks pane 启动时如果连上了 daemon，之后 daemon 因空闲自动关闭（最后一个 GUI 退出 3 秒后），任务列表就会冻住——既不重连也不回退轮询。现在 pane 角色的连接在断开后会非 spawn 自动重连（不会复活已关闭的 daemon，从而不破坏懒关闭机制），同时始终保留一个 tasks.json 兜底轮询，daemon 一离线立刻接管；重连后 daemon 重放快照，自动重新同步。一个损坏的数据帧也不再静默杀死整条事件投递。

三，新增 kobe reload。原地重启所有会话里的 Tasks/Ops pane（复用已有的 respawn-pane 机制），让 kobe 界面层的代码改动直接生效，无需 kobe reset，绝不影响正在运行的 claude 引擎和你的当前一轮。

四，日志机制。pane 运行在终端 alternate-screen 里，stdout 完全不可见，这正是同步问题长期查不到的原因。现在客户端把连接生命周期（订阅、断开、重连、兜底）写入 ~/.kobe/client.log，daemon 把对应的 socket 变化写入 daemon.log。

0.7.3 —— kobe api 升级为自描述的全量控制面、新增 kobe skill install

一，kobe api 全量任务 CRUD。从 6 个 verb 扩到 18 个。除原有 add（参数大幅扩充：标题、分支、base 分支、vendor、status、pin、可选首条 prompt）、fan-out、send、get-task、collect、list，新增 rename、set-branch、set-vendor、set-status、archive、pin、set-active、ensure-worktree、delete、adopt、discover-adoptable。一张声明式的 verb 规格表统一驱动 help、schema、参数校验（必填、枚举、拒绝未知 flag）。spawn-task 保留为 add 的别名。

二，分层探索，不污染上下文。kobe api schema 默认只返回紧凑索引（分组加每个 verb 的摘要，不含参数），agent 再用 kobe api schema --verb 名字 钻取单个 verb 的完整参数，用 --group 看一组，用 --all 看全量。每个 verb 也支持 --help。

三，kobe skill install。把 npx skills add Sma1lboy/kobe 的安装流程包了一层便捷命令，另有 kobe skill status 和 kobe skill command。skill 现在带版本戳：当你升级 kobe 后装着的 skill 落后了，kobe doctor、kobe skill status 以及一次性启动提示都会提醒重装。

0.7.4 —— 事件驱动任务状态（Claude hooks）、外部 worktree 同步

一，事件驱动任务状态。kobe 给每个任务的 worktree 安装 Claude Code 的 hook，引擎把它真正在做什么（开始一轮、结束一轮、被限流、等待权限批准）直接上报给 daemon，daemon 折算成每个任务的活动状态推给侧栏。任务行实时显示：运行时 working、停止后 done、限流 limited、等批准 approve、出错 error，取代以前靠轮询 tmux pane 的猜测。整套机制藏在中立的 EngineHookAdapter 接口之后（Claude 是第一个实现，daemon、CLI、TUI 都不出现任何厂商字符串），Codex 和 Copilot 以后接同一套契约即可。hook 写在 worktree 的 .claude/settings.local.json 里，并通过 .git/info/exclude 对 git 隐藏，不会污染任务的改动 diff；只接管 kobe 用到的事件，用户自己的 hook 完整保留。原有的轮询检测器保留为兜底。内部命令 kobe hook 永不 spawn daemon、永远以 0 退出。

二，外部 worktree 同步。当有人绕过 kobe 直接用 claude --worktree 创建 worktree 时，kobe 可以自动把它收编成一个任务，让它出现在任务列表里并能看它的改动（不需要会话，之后可在任务里开 chat）。这是 opt-in 的：执行 kobe hook setup（默认装在全局 ~/.claude，或用 --repo 指定单个仓库，用 --off 移除）；这个 hook 带标记、合并安全，不会覆盖你自己的 hook。收编是幂等的，kobe 自己创建的 worktree 不会被重复收编。老 worktree 的事件 hook 会在下次进入该任务时自动补装。

0.7.5 —— daemon 版本过期 banner、hook 功能硬化

一，版本过期 banner（这是“前端检测后端版本”的落地）。Bun 没有热重载，升级 kobe 后正在运行的 daemon 仍执行内存里的旧代码，直到 kobe daemon restart（pane 直到 kobe reload），这会悄悄掩盖本次升级。协议版本检查只能抓破坏性变更，普通补丁升级抓不到。现在 daemon 在握手时上报自己的构建版本，前端一旦检测到与启动的二进制不一致，就在 Tasks pane 顶部弹一条非致命 banner（DAEMON OUT OF DATE，提示先 kobe daemon restart 再 kobe reload），daemon 重启、版本一致后 banner 自动消失。kobe doctor 也会报这个偏差。视觉借鉴了 wakey 的 banner 设计，但映射到 kobe 的主题色，不与当前主题冲突。

二，对 0.7.4 hook 功能的对抗性 review 硬化。adopt 增加按路径串行锁，避免并发 WorktreeCreate 为同一 worktree 创建重复任务；.git/info/exclude 的写入加进程内去重，backfill 路径不再每次重复 spawn git、也不会并发重复写；kobe hook setup 记录解析后的真实路径，切换 scope 或执行 --off 时会清理旧位置，不留孤儿 hook；删除任务时显式发一条 idle，避免被复用的同一任务 id 继承到旧的状态徽标。说明：review 里“用户 Stop hook 被覆盖”这一条经查证是误报，Claude Code 跨 scope 是数组合并加去重，kobe 的 hook 与用户的 hook 共存。

升级与验证

安装：npm i -g @sma1lboy/kobe@0.7.5
载入：先 kobe daemon restart，再 kobe reload
验证要点：执行 kobe api schema 应看到分层索引；kobe skill status 应显示 installed v1；新建一个任务跑一轮，侧栏应在运行时显示 working、结束显示 done；执行 kobe hook setup --global 后在别处运行 claude --worktree 应自动出现在任务列表；当 daemon 是旧构建时，Tasks pane 顶部应出现版本过期 banner。

质量

四个版本都通过 typecheck、lint、单元测试、构建门禁，并经过多智能体对抗性 review。

下一步

Codex 与 Copilot 的 hook 适配（中立接口已收拢，后续填具体实现即可）。
