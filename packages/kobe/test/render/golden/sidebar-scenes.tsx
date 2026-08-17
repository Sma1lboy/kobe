/** @jsxImportSource @opentui/react */
/**
 * The sidebar scene catalog — every state of the rail worth locking a frame of.
 *
 * A scene is a fully-specified `SidebarTree` mount plus, optionally, the keys
 * to press before capturing. Keeping the catalog separate from the runner means
 * adding a state is a data edit, and the runner's compare logic never grows.
 *
 * Deliberately excluded from every scene: `kind: "main"` tasks. A project row
 * resolves its label by polling the repo's real git HEAD, so a frame containing
 * one would depend on the checkout the test happened to run against. That row's
 * own logic is locked exhaustively (and hermetically) by the pure state matrix
 * in `test/golden/sidebar-row-state.golden.txt` instead.
 */

import type { TaskEngineState } from "@/client/remote-orchestrator"
import type { TaskActivityState } from "@/engine/hook-events"
import { SidebarTree } from "@/tui-react/panes/sidebar/SidebarTree"
import { tabsByTask } from "@/tui-react/workspace/terminal-tabs-shared"
import type { TabsState } from "@/tui/workspace/terminal-tabs-core"
import { type Task, toTaskId } from "@/types/task"
import type { ReactNode } from "react"

/** Fixed instant for every activity `at` — the row view compares timestamps. */
const AT = 1_760_000_000_000

export const SCENE_WIDTH = 30
export const SCENE_HEIGHT = 22

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repos/kobe",
    branch: `feat/${id}`,
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "in_progress",
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as Task
}

const ALPHA = task("alpha")
const BRAVO = task("bravo")

/** Seed the module-level tab map the tree projects its child rows from. */
function seedTabs(
  entries: ReadonlyArray<{
    taskId: string
    tabs: ReadonlyArray<{ id: string; title: string; kind?: "engine" | "command" }>
  }>,
): void {
  tabsByTask.clear()
  for (const entry of entries) {
    tabsByTask.set(entry.taskId, {
      tabs: entry.tabs.map((tab, i) => ({
        kind: tab.kind ?? ("engine" as const),
        id: tab.id,
        title: tab.title,
        ordinal: i + 1,
        ...(tab.kind === "command" ? { command: ["bash"] } : {}),
      })),
      activeId: entry.tabs[0]?.id ?? "tab-1",
      nextOrdinal: entry.tabs.length + 1,
    } as TabsState)
  }
}

/** Two agent tabs on `alpha`, one on `bravo` — the standard tree shape. */
function seedStandard(): void {
  seedTabs([
    {
      taskId: "alpha",
      tabs: [
        { id: "tab-1", title: "build" },
        { id: "tab-2", title: "review" },
      ],
    },
    { taskId: "bravo", tabs: [{ id: "tab-1", title: "tests" }] },
  ])
}

function tabState(state: TaskActivityState): ReadonlyMap<string, ReadonlyMap<string, TaskEngineState>> {
  return new Map([["alpha", new Map([["tab-1", { state, at: AT }]])]])
}

export interface Scene {
  /** Golden file basename (`<name>.frame.txt`). */
  readonly name: string
  /** Why this frame is worth locking — printed into the golden's header. */
  readonly about: string
  /** Runs before mounting: seeds the module-level tab map. */
  readonly setup: () => void
  readonly element: ReactNode
  /** Keys to type after mount, before capture. */
  readonly keys?: readonly string[]
  /**
   * The frame animates, so the spinner cell must be masked before comparing.
   * Only set on scenes with NO non-agent tab, since the mask would otherwise
   * also swallow that row's plain `·`.
   */
  readonly animated?: boolean
}

function tree(over: Partial<Parameters<typeof SidebarTree>[0]> = {}) {
  return (
    <SidebarTree
      tasks={[ALPHA, BRAVO]}
      selectedId="alpha"
      selectedTabId="tab-1"
      onSelect={() => {}}
      // Present so the labelled create row renders — its absence is a
      // different (host-less) chrome, and the rail's first affordance is
      // exactly the kind of thing a layout change quietly drops.
      onAddTask={() => {}}
      focused={true}
      width={SCENE_WIDTH}
      {...over}
    />
  )
}

export const SCENES: readonly Scene[] = [
  {
    name: "tree-unknown",
    about: "no daemon signal at all — every agent tab rests at the dotted unknown glyph, never a claimed idle",
    setup: seedStandard,
    element: tree(),
  },
  {
    name: "tab-idle",
    about: "a KNOWN-idle tab (the daemon reported it) wears the hollow circle, unlike its unknown siblings",
    setup: seedStandard,
    element: tree({ engineTabState: tabState("idle") }),
  },
  {
    name: "tab-turn-complete",
    about: "unread completion lamp on the tab that finished",
    setup: seedStandard,
    element: tree({ engineTabState: tabState("turn_complete"), selectedId: "bravo", selectedTabId: "tab-1" }),
  },
  {
    name: "tab-permission-needed",
    about: "blocked on the user — the one state whose glyph literally asks a question",
    setup: seedStandard,
    element: tree({ engineTabState: tabState("permission_needed") }),
  },
  {
    name: "tab-rate-limited",
    about: "quota exhausted — the subtitle spells out WHY the row is stuck, outranking the branch",
    setup: seedStandard,
    element: tree({ engineTabState: tabState("rate_limited") }),
  },
  {
    name: "tab-error",
    about: "the engine reported a failed turn",
    setup: seedStandard,
    element: tree({ engineTabState: tabState("error") }),
  },
  {
    name: "tab-running",
    about: "a live turn — the glyph cell animates, so it is masked; everything AROUND it is still locked",
    setup: seedStandard,
    element: tree({ engineTabState: tabState("running") }),
    animated: true,
  },
  {
    name: "tab-running-sibling",
    about: "work in a NON-active tab must light THAT row and leave the active one alone (the borrowed-spinner bug)",
    setup: seedStandard,
    element: tree({
      engineTabState: new Map([["alpha", new Map([["tab-2", { state: "running" as const, at: AT }]])]]),
    }),
    animated: true,
  },
  {
    name: "tab-non-agent",
    about: "a shell/command tab is outside the state vocabulary entirely — plain dot, no circle",
    setup: () =>
      seedTabs([
        {
          taskId: "alpha",
          tabs: [
            { id: "tab-1", title: "build" },
            { id: "tab-2", title: "shell", kind: "command" },
          ],
        },
        { taskId: "bravo", tabs: [{ id: "tab-1", title: "tests" }] },
      ]),
    element: tree(),
  },
  {
    name: "worktree-pin-and-pr",
    about: "worktree-level facts share one right-edge cluster: pin, PR check chip, jump digit",
    setup: seedStandard,
    element: tree({
      tasks: [
        task("alpha", { pinned: true, prStatus: { checkState: "passing" } as Task["prStatus"] }),
        task("bravo", { prStatus: { checkState: "failing" } as Task["prStatus"] }),
      ],
    }),
  },
  {
    name: "search-pruned",
    about: "the query row plus a tree pruned to matches and their ancestors — a hit never floats free",
    setup: seedStandard,
    element: tree(),
    keys: ["/", "bravo"],
  },
  {
    name: "search-tab-title",
    about: "the query reaches a live TAB title and drags its worktree along — the tree's own increment",
    setup: seedStandard,
    element: tree(),
    keys: ["/", "review"],
  },
  {
    name: "view-tabs-archived",
    about: "archived tasks have no sidebar surface — no view tabs, no charlie row (issue #33)",
    setup: seedStandard,
    element: tree({ tasks: [ALPHA, BRAVO, task("charlie", { archived: true })] }),
  },
  {
    name: "move-mode",
    about: "project reorder mode — the chip says so and j/k drag instead of walking",
    setup: seedStandard,
    element: tree({ moveMode: true }),
  },
  {
    name: "recent-jump-row",
    about: "narrow mode's one-keystroke way back into the task you were last inside",
    setup: seedStandard,
    element: tree({ recentTask: BRAVO }),
  },
  {
    name: "zen-chip",
    about: "the zen affordance sits below the tree body, not inside it",
    setup: seedStandard,
    element: tree({ zenActive: true }),
  },
  {
    name: "scratch-flat",
    about: "a scratch task renders no middle worktree row — its shell tab hangs directly under SCRATCH (issue #41)",
    setup: () =>
      seedTabs([
        { taskId: "scratchy", tabs: [{ id: "tab-1", title: "shell 1", kind: "command" }] },
        { taskId: "alpha", tabs: [{ id: "tab-1", title: "build" }] },
      ]),
    element: tree({
      tasks: [task("scratchy", { kind: "dir", scratch: true, repo: "/Users/me", branch: "" } as Partial<Task>), ALPHA],
    }),
  },
  {
    name: "empty",
    about: "no tasks at all — the rail still renders its chrome rather than collapsing",
    setup: () => tabsByTask.clear(),
    element: tree({ tasks: [], selectedId: null, selectedTabId: null }),
  },
]
