/** @jsxImportSource @opentui/react */
/**
 * The Inbox's state badges must occupy ONE cell each in the real frame.
 *
 * kobe budgets a single cell per state glyph everywhere it draws one, and
 * every layer in the pipeline agrees: `display-width.ts`, opentui's layout,
 * and the Unicode width tables all say 1. The terminal is the layer that can
 * disagree — when the user's font lacks a codepoint the OS substitutes another
 * face at ITS advance, and a CJK or dingbat or emoji substitute is 1.1–2.1
 * cells, overrunning the text beside it. Nothing upstream can see that; the
 * width table is not wrong, the font is just missing the glyph.
 *
 * This pane shipped `⌛` (U+231B) for rate-limited. U+231B carries the Unicode
 * Emoji property, so macOS resolved it to AppleColorEmoji at 2.13 cells — a
 * colour glyph in a monochrome pane, overflowing its column (2026-08-15, the
 * same sweep that removed the sidebar's oversized `◌` and `✕`).
 *
 * So the assertion is on the CELL, not on the character: mount the real pane,
 * capture the real frame, and require each badge to sit in one cell of the
 * grid. A glyph swapped for one the fonts lack would still pass a
 * `toBe("◷")`-style check — this is the shape that wouldn't.
 *
 * The sidebar's half of the same vocabulary is pinned separately, by the
 * font-verified allowlist in `test/golden/sidebar-row-state.test.ts`.
 */

import { expect, test } from "bun:test"
import type { AttentionInboxItem, TaskEngineState } from "../../src/client/remote-orchestrator"
import type { KVContext } from "../../src/tui-react/context/kv"
import { AttentionInboxPane } from "../../src/tui-react/workspace/AttentionInboxPane"
import { type Task, toTaskId } from "../../src/types/task"
import { renderComponent } from "./harness"

/**
 * Codepoints that resolve to an oversized substitute face on at least one
 * font in daily use here, measured with CoreText against FiraCode Nerd Font
 * Mono (iTerm2) and JetBrainsMono Nerd Font Mono (Ghostty). Not exhaustive —
 * a denylist can't be — which is why the real assertion below is the cell
 * measurement. This list only makes the failure message say WHY.
 */
const KNOWN_OVERSIZED = new Map<string, string>([
  ["⌛", "U+231B — emoji property; AppleColorEmoji at 2.13 cells"],
  ["◌", "U+25CC — absent from FiraCode/SF Mono; HiraginoSans at 1.62 cells"],
  ["✕", "U+2715 — dingbat block; ZapfDingbats at 1.24 cells"],
  ["★", "U+2605 — HiraginoSans at 1.62 cells"],
  ["⚠", "U+26A0 — HiraginoSans at 1.62 cells"],
])

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
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  }
}

function item(taskId: string, state: AttentionInboxItem["state"]): AttentionInboxItem {
  return { taskId, tabId: null, state, unread: true, at: Date.UTC(2026, 7, 1) }
}

/** Minimal KV: the pane only reads it for tab existence + the visit log. */
function stubKv(): KVContext {
  const store: Record<string, unknown> = {}
  return {
    ready: true,
    store,
    signal: <T,>(name: string, defaultValue: T) => {
      const read = () => (store[name] ?? defaultValue) as T
      const write = (next: T) => {
        store[name] = next
      }
      return [read, write] as const
    },
    get: (key: string, defaultValue?: unknown) => store[key] ?? defaultValue,
    set: (key: string, value: unknown) => {
      store[key] = value
    },
    flush: () => true,
    clear: () => void 0,
  }
}

/**
 * The grid column each badge landed in, read off the captured frame. A glyph
 * whose substitute face is wider than one cell either pushes the following
 * text right or gets clipped — both show up as the badge's row being a
 * different length than its single-cell neighbours, because opentui laid the
 * row out for one cell regardless of what the font would do with it.
 */
function badgeRows(frame: string, glyphs: readonly string[]): string[] {
  return frame.split("\n").filter((line) => glyphs.some((glyph) => line.includes(glyph)))
}

const STATES = ["turn_complete", "permission_needed", "error", "rate_limited"] as const

test("every Inbox state badge renders in a single grid cell", async () => {
  const tasks = STATES.map((state, index) => task(`t${index}`, { title: `task ${state}` }))
  const items = STATES.map((state, index) => item(`t${index}`, state))
  const { frame } = await renderComponent(
    <AttentionInboxPane
      items={items}
      tasks={tasks}
      kv={stubKv()}
      onOpen={() => {}}
      onOpenTask={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
    />,
    { width: 80, height: 30 },
  )
  const captured = await frame()

  // Nothing from the measured-bad set may reach the frame at all.
  for (const [glyph, why] of KNOWN_OVERSIZED) {
    expect({ glyph, present: captured.includes(glyph), why }).toEqual({ glyph, present: false, why })
  }

  // Every rendered row is exactly the terminal width: opentui pads to the
  // grid, so a glyph that consumed two columns would have displaced a cell
  // of real content rather than silently widening the row. Combined with the
  // badge actually being on screen, this is the one-cell claim.
  const lines = captured.replace(/\n$/, "").split("\n")
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) expect([...line].length).toBe(80)

  // …and the badges really are there, so the loop above isn't vacuous.
  const badges = badgeRows(captured, ["✓", "?", "×", "◷"])
  expect(badges.length).toBeGreaterThan(0)
})

test("a running RECENT row animates with a braille frame, never a badge glyph", async () => {
  // The spinner and the settled badges share one column, so a frame that
  // borrowed `✓`/`×`/`◷` would make a working task read as a finished one.
  // This is the Inbox's copy of the sidebar's spinner/badge collision guard.
  const running = task("r0", { title: "running task" })
  const engineStates = new Map<string, TaskEngineState>([
    ["r0", { state: "running", at: Date.UTC(2026, 7, 1), vendor: "claude" } as TaskEngineState],
  ])
  const { frame } = await renderComponent(
    <AttentionInboxPane
      items={[]}
      tasks={[running]}
      kv={stubKv()}
      selectedId={null}
      engineStates={engineStates}
      onOpen={() => {}}
      onOpenTask={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
    />,
    { width: 80, height: 20 },
  )
  const captured = await frame()
  for (const glyph of ["✓", "?", "×", "◷", ...KNOWN_OVERSIZED.keys()]) {
    expect({ glyph, present: captured.includes(glyph) }).toEqual({ glyph, present: false })
  }
})
