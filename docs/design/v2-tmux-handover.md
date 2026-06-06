# v0.6 — tmux 接管模型

> Status: 拍板, 待实现. 2026-05-22.  
> Audience: 接手 0.6 重构的 agent / 之后翻这份历史的人.  
> See also: `KOB-208` (spike), `KOB-225` (tmux 持久 session 起步), 本 design doc 是这两个 issue 自然延伸出来的产品形态.

## 1. Why

Anthropic 2026-06-15 计费政策: `claude -p` / Agent SDK / 第三方程序化用量走独立的 \$200/月额度, **不再占订阅额度**; 只有交互式 Claude Code / Cowork / chat 继续走订阅. 详见 KOB-208.

kobe v0.5 把 `claude` 当 stream-json 子进程驱动 (`engine/claude-code-local/spawn.ts`), 所有用量吃 \$200 桶. 重并行下不够用. v0.6 改成**直接驱动交互式 claude**, 用量回到订阅.

## 2. 形态

```
┌─────────── kobe (outer monitor, opentui+Solid) ──────────┐
│  Sidebar: tasks  │  Live preview rail (capture-pane)     │
│  + status        │  Cost / status / cross-task search    │
│  + worktree mgmt │  Click task → tmux attach (handover)  │
└──────────────────────────────────────────────────────────┘
                              │
                              ▼  ⏎ enter
┌────────── tmux session `kobe-<task-id>` (native) ────────┐
│   pane 0 (left, 60%)         │   pane 1 (right top)       │
│   claude / codex             │   Ops window (kobe-ops)    │
│   原生 TUI 占用              │   send-keys 注入 + files   │
│                              │   watcher                   │
│                              │   ┌──────────────────────┐ │
│                              │   pane 2 (right bottom)    │
│                              │   terminal (zsh @worktree) │
└──────────────────────────────────────────────────────────┘
        Ctrl+Q (detach-client, kobe socket only) → 回外层
```

外层 kobe (opentui+Solid) 渲染监控视图; 进入任务 = `tmux attach` 到该任务的预 split session, claude 在左 pane 原生跑 (订阅计费), 右上 Ops pane 提供元操作, 右下 terminal pane 跑 worktree-bound shell.

## 3. 删除清单 (一刀切, 不留兼容)

下列模块在 0.6.0 整体砍掉, 0.5.x 保留:

| 模块 | 命运 |
|---|---|
| `src/engine/claude-code-local/{spawn,stream,registry,plan-usage,sessions,normalize}.ts` | 删除 |
| `src/engine/claude-code-local/binary.ts` | 保留 (外层需要发现 claude) |
| `src/engine/claude-code-local/history.ts` | 保留 (外层 live preview / 离线摘要要读 JSONL) |
| `src/engine/codex-local/` 整个目录 | 删除 spawn/stream 部分, 同 claude 处理 |
| `src/engine/gemini-local/` | 删除 (没有交互式 TUI 等价物, 不进 0.6) |
| `src/orchestrator/core.ts` 的 `pumpEvents` / `dispatchEvent` / `requestPR` 注入 | 删除 |
| `src/orchestrator/user-input.ts` | 删除 |
| `src/types/engine.ts` 的 `EngineEvent` / `SessionHandle` / `UserInputPayload` / `OrchestratorEvent` | 删除, `AIEngine` interface 瘦身到只剩 `readHistory` + `deleteHistory` |
| `src/tui/panes/chat/{Composer,ComposerView,ComposerQueue,ComposerPathChips,composer/,bash-*,use-bash-mode,queue,context-meter,markdown-parser,Markdown,Loading,UserInputRows,TodoStatusLine,todo-render,tool-banners,tool-fold,tool-registry,ToolRow,MessageList,MessageRows,Chat,ChatView,store,use-chat-session,use-chat-tabs,scrollback,edit-diff,pending-input-pane-state,spinnerVerbs,chat-utils,message-figures}` | 删除整个 chat pane |
| `src/tui/panes/preview/` | 删除 (file preview 之后会用新方式重做, 但不背老代码) |
| `test/behavior/fake-engine.ts` 及其 HTTP side-channel | 删除 |
| Behavior 测试中所有依赖事件流断言的用例 | 删除或重写为 tmux 模型 |

**保留并放大:**
- 任务索引 / worktree 管理 / sidebar / 主题 / 全局 keybinding 栈 / KV / dialog 系统
- `engine/claude-code-local/binary.ts` + `engine/claude-code-local/history.ts`
- `engine/account-detect.ts` (外层显示当前账号)
- `session/usage-metrics.ts` (外层 cost dashboard)
- `tui/panes/terminal/{tmux.ts,fullscreen.tsx}` (现成的接管基础设施)

## 4. 之后用新方式实现 (0.6.x 跟进, 不进 0.6.0)

| 功能 | 新形态 |
|---|---|
| **Quick-fork** | 外层 sidebar 快捷键, 选 base branch → 创建 worktree + 新 tmux session, 不再耦合到 chat composer |
| **Create-PR** | Ops pane 一行快捷键 → 读 `pr/instructions.ts` 模板 → `tmux send-keys` 注入到左 pane claude. 任务索引仍持有 PR 状态 |
| **File preview** | Ops pane 内部模式: 文件列表 → 选中 → 调出 diff/cat 视图 (在 Ops pane 自己的子区域, 不再是 opentui 全局 preview tab) |

## 5. 显式不做 (v0.6 不再保留这些功能)

`@file` mention · prompt queue · permission mode 切换 UI · bash composer mode (`! cmd`) · TodoWrite checklist 内联渲染 · AskUserQuestion / ExitPlanMode 审批弹窗 · `/recap` 自动总结 · context meter · quick-* 快捷面板 (除 fork). 这些 v0.5 自渲染功能在 v0.6 之后**不再以任何形式出现**——claude / codex 自身的交互式 TUI 已经覆盖等价交互, kobe 不重做.

## 6. 执行步骤

四步走, 每步可单独 ship + 回滚:

### Step A — 砍 headless, 切默认到 interactive
- 删 §3 所有 "删除" 项
- chat pane 替换成 `ClaudeLauncher` (已存在), 不再有任何 `KOBE_CHAT_ENGINE` 环境变量分支
- `Task` / `TaskIndex` 瘦身: 删 `tabs` 的 sessionId / 多 tab / model / effort / permissionMode 字段
- orchestrator 只剩任务/worktree 生命周期, 不再 pump 事件
- 验证: 启动 kobe → 选任务 → ⏎ 进入 → claude 跑 → Ctrl+Q 回到 kobe. typecheck/lint/单测绿.
- **Linear:** KOB-227

### Step B — tmux 预 split 三 pane
- 改 `tmux.ts` 的 `ensureSession`: 建 session 时
  - `new-session -d -s <name> -c <wt> 'claude'`
  - `split-window -h -t =<name>:0 -p 40 -c <wt> 'kobe-ops'` (占位, B 阶段先跑 `lsd --tree --git -L 2 ; sleep infinity` 之类)
  - `split-window -v -t =<name>:0.1 -p 50 -c <wt>` (shell)
- attach 后焦点默认在 pane 0 (claude)
- 验证: 进入任务看到三 pane 布局, claude/files/terminal 各就位.
- **Linear:** KOB-228

### Step C — Ops pane 自研小工具 (`packages/kobe-ops`)
- 独立 npm 包 `@sma1lboy/kobe-ops`, 同 bun workspace
- 启动入参: `--task-id <id> --worktree <path> --target-pane =<session>:0.0`
- 功能 (0.6.0 范围内): 文件 watcher (git status + tree); 之后 (0.6.x): quick-fork / create-PR / file preview
- send-keys 注入用 `tmux -L kobe send-keys -t <target>` (会复用同一 socket)
- **Linear:** KOB-229

### Step D — 外层监控变厚
- Live preview rail: 每 1s `tmux capture-pane -t kobe-<id> -p` 显示当前 claude 状态
- Cost dashboard (照搬 agent-deck `internal/ui/cost_dashboard.go` 形态, 数据来自 `session/usage-metrics.ts` 读 JSONL)
- Cross-task search / 批量动作 (后续 0.6.x, 不阻塞 0.6.0 发布)
- **Linear:** KOB-230 (D core), KOB-231 (D 后续)

## 7. 版本路线

- `0.5.x` (current): 自研 chat + headless `claude -p`. 已知账单问题不在这条线修.
- `0.6.0`: Step A + B + C (core) + D (live preview rail) 完成后发布.
- `0.6.x`: D 余下 + 4 节 "之后用新方式实现" 的 quick-fork / create-PR / file preview.

切版本号是为了让用户清楚 0.5 → 0.6 是 **产品形态变更**, 不是补丁.

## 8. 不变的契约

- worktree 路径现在是 `~/.kobe/worktrees/<repo-key>/<slug>/`；repo-local `.kobe/worktrees` 和旧的 `<repo>/.claude/worktrees/<slug>/` 任务继续兼容。
- 任务索引仍是 `~/.kobe/tasks.json` 单 JSON 文件
- claude history 仍读 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
- `tmux -L kobe` 独占 socket (KOB-225 拍的, 不污染用户自己的 tmux)
- 全局 Ctrl+Q = "detach 当前接管 / 返回外层" (KOB-225 绑过, 0.6 沿用)
