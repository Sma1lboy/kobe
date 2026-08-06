# Handoff — 侧栏三层树（project → worktree → tab），右边纯终端 (2026-08-01)

> 上一份（brand-studio × brand-video 生产线，2026-07-03）归档在
> [`docs/HANDOFF-brand-studio-2026-07-03.md`](./docs/HANDOFF-brand-studio-2026-07-03.md)。

## Read first

1. [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md) — 新和弦 `sidebar.tree.toggle`（h/l/space）
   **是 PROPOSED，等你签字**；rail 的 prefix+1/2/3 那段已更新。
2. [`packages/kobe/src/tui/panes/sidebar/tree-core.ts`](./packages/kobe/src/tui/panes/sidebar/tree-core.ts)
   — 树的形状（纯函数，11 个单测）。读这个文件的头注释就懂整体设计。
3. [`packages/kobe/test/render/sidebar-tree.test.tsx`](./packages/kobe/test/render/sidebar-tree.test.tsx)
   — 5 个 render 测试，**每条都真按键**（memory `render-tests-are-not-e2e` 的教训）。

## Goal（你 2026-08-01 的原话 + 选型）

> 抛弃现有的这种 chattab 很多 chattab 的设计……左边一个 project 下面有很多 worktree
> （主 worktree、其他 worktree），每个 worktree 有很多 tab 就在右边……每个状态可以单独管理。

追问后你选的是 **A：树长到 tab，右边纯终端** —— 横向 tab 条彻底删掉，切 tab = 在左树上下移。

## Current state

**分支 `feat/worktree-tree`，两个提交（`83296f43` 主体 + `2bc4e2ee` 收尾），未推。**
main 干净（0.8.43 已发布）。

第二个提交（2026-08-01 下午）干了什么：
- **视觉 ground-truth e2e 全绿**（browser `/harness` → xterm → PTY → 真 OpenTUI，
  隔离 fixture home）。真跑出一个 bug 并已修：project 头行点击原来走 `activateRow`，
  把 project key 当 task id 去 parse；现在点击 = 折叠/展开该组（和 twisty 语义一致）。
  e2e 的侧栏锚点击也因此从 (24,24) 挪到空白区 —— 那个像素在树里正是头行。
- `sandbox.spec.ts` 的就绪断言从 PROJECTS/TASKS 头改为等树的行，并断言 PROJECTS 不存在。
- **host.tsx 493 行**（<500）：页面/nav 状态抽进 `host-pages.tsx` 的 `useHostPagesState`，
  孤儿 snapshot sweep 挪进 `use-workspace-selection.ts`。
- **changeset 已写**（patch）。**darwin visual 基线已重生成**。

数据模型**确认不用改**——你判断对了：`Task.kind` 已经区分 `main`/`task`/`dir`，
tab 状态本来就是 `Map<taskId, TabsState>`，天然按 worktree 分组。改的全在视图 + 导航。

关键设计（省得重读代码）：树是**带 depth 的扁平行列表**，不是嵌套结构。因为整套导航
就是 `flatTaskIds` 上的一个游标，把 tab 行编进同一个数组，j/k/enter/gg/ctrl+数字 全部
零改动继承；tab 行 id = `${taskId}::${tabId}`（复用 PTY registry 的 key 格式）。

已完成、已验证（typecheck + 67 render + 898 unit + 双侧 lint 全绿）：

| 文件 | 作用 |
|---|---|
| `src/tui/panes/sidebar/tree-core.ts` | 纯函数：`buildTreeRows` / `treeFlatIds` / `parseRowId` / 展开态 |
| `src/tui-react/panes/sidebar/SidebarTree.tsx` | 树组件（Sidebar.tsx 的兄弟，不是模式开关） |
| `src/tui-react/panes/sidebar/tree-rows.tsx` | 三种行的渲染 + twisty |
| `src/tui-react/panes/sidebar/tree-panel.tsx` | 单 scrollbox 的树体 |
| `src/tui-react/panes/sidebar/use-tree-state.ts` | 展开/折叠 + tab 投影 |
| `src/tui-react/workspace/host-sidebar.tsx` | 选哪个侧栏（从 host.tsx 抽出来的） |
| `src/state/sidebar-tree.ts` | `sidebar.mode` 偏好，**默认 tree** |
| `src/state/tab-strip.ts` | 布尔 → 三态（`never`/`multipleOnly`/`always`），**默认 never** |

## 你早上验收的路径

```bash
cd /Users/jacksonc/i/kobe && git checkout feat/worktree-tree
bun --filter @sma1lboy/kobe dev:sandbox
```

要看的：
1. 左边应该是 `kobe` → 它的 worktree → 选中那个 worktree 的 tab（**只有选中的默认展开**）。
2. `h`/`l` 折叠展开，`j`/`k` 走位，`enter` 在 tab 行上应该切到那个 tab 的终端。
3. 右边**不应该有横向 tab 条**了。想要回来：`s` → General → Terminal → `tab strip` 那行 enter 循环。
4. 想回旧侧栏：同一页的 `Sidebar as a tree` 取消勾选。

## ⚠️ 还剩的

1. **新和弦 h/l/space 等你签字**（`docs/KEYBINDINGS.md` 里标了 PROPOSED）。
   h/l 是 vim 树的惯例、FileTree 已经用它们做同样的动作；但按规矩这是你的手感判断。
2. **你本人的 dev:sandbox 手感验收**（下面"验收路径"）。视觉 e2e 已真按键跑过
   树的渲染/走位/页面往返，但 enter 切 tab 的手感、h/l 的节奏是你的判断。
3. **linux visual 基线**本机造不出来，推上去后走 CI artifact 拉回来（0.8.43 验证过的路子）：
   `gh run download <run-id> -n "visual-ground-truth-<run-id>" -D /tmp/x`。
4. **搜索 / 项目筛选 / 排序 / move mode 在树里没接** —— 目前只有 flat 侧栏有。
   树的 props 收了但没用，不确定树形态下这些还要不要（可能项目筛选就被树本身取代了）。

## 本轮另外做完的事（已在 main）

- **0.8.42 发版失败的真因**：我把看板从 `prefix+c` 挪到 `prefix+1`（rail 那批），e2e 没跟。
  更阴的是断言写的是 `toContainText("Kanban")`，而新 rail 侧栏**常驻**印着 "Kanban"，
  所以按键失效时这条断言照样通过 —— 纯假阳性。已修成等**卡片**文本，并抽了 `openKanban()`。
- **0.8.43 已发布**（npm latest + 三平台二进制齐全，CI 全绿）。
