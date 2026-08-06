# Graph Engineering：停止和 AI 结对，开始给 AI 画图

> Prompt engineering 教你怎么说一句话。Context engineering 教你怎么喂一个会话。
> 但当你同时跑五个 agent 的时候，真正的工程对象既不是词也不是上下文——是**图**。

## 从"一次对话"到"一张图"

过去两年我们和 coding agent 的关系是结对编程：你出题，它写码，你盯着流式输出，随时准备抢方向盘。这个模式的天花板显而易见——**你的注意力是单线程的，agent 的产能不是**。

2026 年的现实是：生成代码已经不贵了，贵的是决定生成什么、验证生成得对不对、以及把对的那份合进去。瓶颈从"写"移到了"编排 + 裁决"。

应对这个转移的工程实践，我们叫它 **graph engineering**：把一次交付显式建模成一张图——

- **节点**：一次独立的尝试。不是一个"聊天窗口"，而是一个完整的执行单元：`git worktree + engine 会话 + 分支`。它有自己的文件系统隔离、自己的历史、自己的成败。
- **边**：依赖与数据流。B 需要 A 的结论才能开工，是一条边；五个节点从同一个 prompt 出发互不依赖，是五条平行边。
- **门（gate）**：人类裁决点。比较、否决、合并赢家——这些不该被自动化掉，该被工程化到最省注意力的位置。

你写的不再是 prompt，是拓扑。

## 四个原语

一张 agent 图跑起来只需要四个动词。多了就是过度设计。

### 1. Fan-out：一个问题，N 次独立尝试

对不确定的问题（"简化这个 auth 流程"），单次尝试的方差极大。fan-out 把方差变成资产：五个节点各自在隔离的 worktree 里跑，谁也污染不了谁，也污染不了你的主 checkout。

```bash
kobe api fan-out \
  --repo "$PWD" \
  --agents claude:2,codex:2,copilot:1 \
  --prompt "Try independent approaches to simplify the auth flow."
```

关键词是**隔离**。没有 worktree 级隔离的"并行"是五个 agent 在同一个工作区里打架。

### 2. Supervise：显式汇报，而不是猜

节点跑完了吗？成了还是败了？这件事只有两种可靠来源：**worker 显式汇报的结果**，或者**你亲自看**。从终端输出的语气里猜"它好像做完了"不算。

```bash
# worker 侧：干完活显式汇报，成败是字段不是散文
kobe api report --outcome succeeded --summary "auth flow simplified, 3 files"

# coordinator 侧：阻塞等待所有节点落定，拿回结构化结果
kobe api await --task-ids a,b,c --timeout-secs 900
# → { timedOut, tasks: [{taskId, settled, outcome, summary}] }
```

两条从实践里烫出来的纪律：

- **成败必须是结构化字段，不是散文。** "我修好了大部分问题"不是 `--outcome succeeded`。
- **沉默不等于死亡。** 一个正经的编码任务跑 15-60 分钟很正常。`await` 超时返回的是 checkpoint（`timedOut: true`），不是失败信号——不要因为一个节点半小时没说话就杀掉重跑。

### 3. Observe：读会话，不要刮屏幕

想知道一个节点在干什么，最差的办法是去 scrape 它的终端——全屏 TUI 的转义序列会把你（或者你的 coordinator agent）活埋。正确来源是 **engine 自己的会话记录**：结构化、有边界、可分页。

```bash
kobe api read-output --task-id <id>
# → source: "history"（engine 会话的结构化分页）
#   或 source: "terminal" + fallbackReason（有界终端尾巴，如实标注）
```

原则是**精确优先于方便**：要么确证读的就是这个节点的这个会话，要么明确降级为有界的终端尾巴并如实标注降级原因。cursor 钉死在一个会话上——会话被替换（resume/compaction）时返回 `SOURCE_CHANGED` 而不是悄悄切换。绝不"读这个目录里最新的 session"式串台。

### 4. Fan-in：比较，合并赢家，归档其余

图的收敛点是人。diff 五个 worktree，挑一个赢家 merge，其余归档。这一步的工程化空间在于**把裁决成本压到最低**：并排 diff、一键 PR、批注直接回喂给 agent 修改——而不是把裁决本身交给另一个 AI 然后祈祷。

## 用 kobe 跑图

kobe 是我们为这套实践做的终端工具：一个 TUI 管理所有节点，每个任务 = worktree + engine 会话 + 分支，daemon 常驻——**你断开 SSH，图继续跑**。

一个真实的工作流：

```bash
ssh devbox && cd your-repo && kobe   # 图跑在代码所在的机器上
```

1. `n` 建任务，选 engine（claude / codex / copilot / 任何你配置的 CLI），fan-out 三个尝试；
2. 合上笔记本去吃饭——会话由独立的 PTY host 托管，TUI 和 daemon 都杀不死它；
3. 回来逐个看 diff，给赢家发 PR，归档其余两个；
4. 或者更进一步：装上 companion skill（`kobe skill install`），让你正在对话的 Claude Code 自己去 fan-out、等待、收结果——**agent 编排 agent**，你只守门。

```bash
kobe api fan-out --repo "$PWD" --agents claude:3 --prompt "..."
kobe api await --task-ids <a,b,c>   # 阻塞到所有节点落定，拿回结构化的 succeeded/failed
```

## 反模式清单

这些坑我们自己踩过，也从同行的设计文档里核对过（stably 的 orca 团队在他们的编排 checklist 里写了几乎同样的清单，殊途同归）：

- **别造调度器。** 图的拓扑该由人（或 coordinator agent）显式决定，不该由一个"智能分配器"猜。你需要的是原语，不是平台。
- **别自动重试沉默的节点。** 见上：沉默不是证据。自动替换一个"看起来死了"的 worker，大概率是杀了一个正在思考的。
- **别让清理动作先于确认。** 删除一个 worktree 之前先确认它是干净的——先杀会话再发现目录删不掉，你就同时失去了会话和干净的现场。
- **别把 worker 的自我汇报当成已验证的事实。** "worker 说成了"和"CI 说绿了"是两个可信度等级，图上应该都留痕。
- **深度别超过 3-4 层。** 依赖链一深，一个节点的失败在图上的爆炸半径就不可控了。宽比深好，fan-out 比 pipeline 好。

## 结语

Prompt engineering 优化一句话的产出，context engineering 优化一个会话的产出，graph engineering 优化的是**你每小时注意力换到的已合并代码量**。

工具会继续换，图不会。开始画图。

---

*kobe 是开源的（MIT）：`bun install -g @sma1lboy/kobe`，或者 `bunx @sma1lboy/kobe` 直接试。*
