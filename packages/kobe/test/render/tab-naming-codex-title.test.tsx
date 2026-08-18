/** @jsxImportSource @opentui/react */
/**
 * The tab auto-naming pass (`useTabNaming`), end to end for the engine whose
 * session id kobe cannot pin.
 *
 * Claude tabs carry a `--session-id` kobe chose at spawn, so the pass has
 * always had a session to read a first prompt from. Codex accepts no such
 * flag — its tabs had NO id, were skipped entirely, and wore `codex N`
 * forever. The one place codex does publish its thread id is its own OSC
 * title (it writes the id there until the thread is named), so the pass now
 * reads it back through the engine contract (`sessionIdFromTitle`) and names
 * the tab from that thread's rollout.
 *
 * Lives in the bun-run render track: the hook is a React effect, so it needs
 * a real renderer to mount against.
 */

import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ReactNode } from "react"
import { type TabLifecycleIO, useTabHydration, useTabNaming } from "../../src/tui-react/workspace/use-tab-lifecycle"
import type { EngineTab, TabsState } from "../../src/tui/workspace/terminal-tabs-core"
import { act, renderComponent } from "./harness"

/** A codex thread id, exactly as codex writes it into its OSC title. */
const THREAD_ID = "01a00ee9-f0e9-7503-a11c-83b4eface0f6"
const FIRST_PROMPT = "make the sidebar scroll"

let codexHome: string | undefined
const priorCodexHome = process.env.CODEX_HOME

afterEach(async () => {
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset when the var was unset before the test (assigning undefined leaves it as the string "undefined").
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = priorCodexHome
  if (codexHome) await rm(codexHome, { recursive: true, force: true })
  codexHome = undefined
})

/** A real `~/.codex` tree holding one rollout for THREAD_ID. */
async function seedCodexRollout(): Promise<void> {
  codexHome = await mkdtemp(path.join(tmpdir(), "kobe-codex-home-"))
  const day = path.join(codexHome, "sessions", "2026", "08", "18")
  await mkdir(day, { recursive: true })
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id: THREAD_ID, cwd: "/wt" } }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-18T00:00:01Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: FIRST_PROMPT }] },
    }),
  ]
  await writeFile(path.join(day, `rollout-2026-08-18T00-00-00-${THREAD_ID}.jsonl`), `${lines.join("\n")}\n`)
  process.env.CODEX_HOME = codexHome
}

/** A mutable `TabLifecycleIO` whose `update` refreshes `stateRef` like the host's. */
function lifecycleIO(state: TabsState, vendor: "claude" | "codex"): TabLifecycleIO & { state: () => TabsState } {
  let current = state
  return {
    stateRef: {
      get current() {
        return current
      },
    },
    propsRef: { current: { vendor } },
    update: (next) => {
      current = next
    },
    state: () => current,
  }
}

/** The tab under test — always an engine tab, so assertions read `EngineTab`. */
function engineTab(state: TabsState): EngineTab {
  const tab = state.tabs[0]
  if (!tab || tab.kind !== "engine") throw new Error("expected an engine tab")
  return tab
}

function codexTabs(over: Record<string, unknown> = {}): TabsState {
  return {
    tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1, vendor: "codex", ...over } as never],
    activeId: "tab-1",
    nextOrdinal: 2,
  }
}

/** Poll until `done()` or the budget runs out — the pass runs on a 5s interval. */
async function until(done: () => boolean, budgetMs = 12_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
}

function Naming({ io }: { io: TabLifecycleIO }): ReactNode {
  useTabNaming(io)
  return <text>naming</text>
}

function Hydrating({ io }: { io: TabLifecycleIO }): ReactNode {
  const hydrating = useTabHydration(true, io)
  return <text>{hydrating ? "hydrating" : "ready"}</text>
}

test("names a codex tab from the thread id in its own OSC title", async () => {
  await seedCodexRollout()
  const io = lifecycleIO(codexTabs({ lastTitle: THREAD_ID }), "codex")
  await renderComponent(<Naming io={io} />)

  await until(() => engineTab(io.state()).autoTitle != null)
  expect(engineTab(io.state()).autoTitle).toBe(FIRST_PROMPT)
  // Deriving a title off a real transcript also proves the session exists,
  // which is exactly what `spawned` records (it gates the resume path).
  expect(engineTab(io.state()).spawned).toBe(true)
}, 20_000)

test("a title that is NOT an id leaves the tab unnamed", async () => {
  await seedCodexRollout()
  // A named thread publishes its NAME, which is not a session id — there is
  // nothing to look up, and the tab keeps its vendor default.
  const io = lifecycleIO(codexTabs({ lastTitle: "rework the parser" }), "codex")
  await renderComponent(<Naming io={io} />)

  await until(() => engineTab(io.state()).autoTitle != null, 6_000)
  expect(engineTab(io.state()).autoTitle).toBeUndefined()
}, 20_000)

test("hydration re-verifies a rehydrated tab's session against the real store", async () => {
  const io = lifecycleIO(codexTabs({ sessionId: "00000000-0000-4000-8000-000000000000", spawned: true }), "codex")
  const handle = await renderComponent(<Hydrating io={io} />)

  // The verification pass flips React state when it lands — drive it under
  // act() so the renderer sees the same commit the assertion below reads.
  await act(async () => {
    await until(() => engineTab(io.state()).spawned === false, 6_000)
  })
  // The snapshot claimed the session had run; the store says otherwise, so
  // the next spawn opens fresh instead of resuming a session that isn't there.
  expect(engineTab(io.state()).spawned).toBe(false)
  expect(await handle.frame()).toContain("ready")
}, 20_000)
