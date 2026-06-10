/**
 * Guard for app.tsx retirement slice 1 (docs/design/app-retirement.md).
 *
 * Two consolidations this pins, both source-level (the outer monitor is a
 * deprecated shell — rendering it under vitest would drag in @opentui; the
 * repo's precedent for guarding render-process invariants is a source scan,
 * see test/tui/render-path-sync-guard.test.ts):
 *
 * 1. Selection bookkeeping. The daemon-backed active task (KOB-247) is the
 *    PRIMARY selection source; the kv key `lastSelectedTaskId` is reduced to
 *    a boot-time fallback whose semantics are "last ENTERED task" — shared
 *    with direct.ts's `chooseInitialTask`. That means app.tsx must write the
 *    key exactly ONCE (in `enterTask`), and must seed its boot selection
 *    from `activeTaskSignal()`. A second write creeping back in (e.g. on
 *    highlight moves) silently re-introduces the double bookkeeping this
 *    slice removed and re-skews the key away from direct.ts's semantics.
 *
 * 2. Monitor polling hygiene. LivePreview / CostDashboard run async
 *    subprocess/fs work on a setInterval tick; without an in-flight guard,
 *    a slow run stacks overlapping refreshes and (LivePreview) lets a stale
 *    task's late frame overwrite the newly selected task's. Each view must
 *    keep its in-flight dedupe and its onCleanup clearInterval.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

function readTui(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/tui/${rel}`, import.meta.url)), "utf8")
}

describe("app.tsx selection consolidation (retirement slice 1)", () => {
  const source = readTui("app.tsx")

  test("kv `lastSelectedTaskId` is written exactly once — the enterTask boot-fallback", () => {
    const writes = source.match(/kv\.set\("lastSelectedTaskId"/g) ?? []
    expect(
      writes,
      "app.tsx must persist lastSelectedTaskId only on task ENTRY (mirroring direct.ts) — " +
        "extra writes re-introduce the selection double bookkeeping removed in retirement slice 1",
    ).toHaveLength(1)
  })

  test("boot selection seeds from the daemon-backed active task before the kv fallback", () => {
    // The createSignal initializer must consult activeTaskSignal() ahead of
    // the persisted kv value — daemon active task is the primary source.
    expect(source).toMatch(/createSignal<string \| null>\(\s*props\.orchestrator\.activeTaskSignal\(\)\(\)\s*\?\?/)
  })

  test("the live follow of the shared active-task focus (KOB-247) is still wired", () => {
    expect(source).toContain("props.orchestrator.activeTaskSignal()()")
    expect(source).toContain("setActiveTask(id)")
  })
})

describe("monitor views poll with in-flight dedupe (retirement slice 1)", () => {
  for (const rel of ["panes/monitor/LivePreview.tsx", "panes/monitor/CostDashboard.tsx"]) {
    const source = readTui(rel)

    test(`${rel} never schedules a bare async refresh on its interval`, () => {
      // The pre-slice-1 shape: setInterval(() => void refresh(), …) — no
      // dedupe, overlapping runs under load. The tick must go through the
      // guarded wrapper instead.
      expect(source).not.toMatch(/setInterval\(\s*\(\)\s*=>\s*void\s+refresh\(\)/)
      expect(source, `${rel} must guard its refresh with an in-flight flag`).toMatch(/\binFlight\b/)
    })

    test(`${rel} clears its interval on cleanup`, () => {
      expect(source).toMatch(/onCleanup\(\(\)\s*=>\s*clearInterval\(timer\)\)/)
    })
  }
})
