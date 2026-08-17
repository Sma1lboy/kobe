/** @jsxImportSource @opentui/react */
/**
 * Narrow condensed tab strip (issue #14, M3): below the breakpoint the
 * strip shows only the ACTIVE tab plus a `2/3` position counter — and it
 * renders even though the default strip mode is `never`, because the
 * sidebar tree (the reason it defaults off) is not on screen beside a
 * narrow workspace. Desktop rendering keeps the mode gate.
 */

import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChatTabTurnState } from "../../src/engine/turn-detector"
import { TabStrip } from "../../src/tui-react/workspace/tab-strip"
import type { TerminalTab } from "../../src/tui/workspace/terminal-tabs-core"
import { renderComponent } from "./harness"

process.env.KOBE_HOME_DIR ??= mkdtempSync(join(tmpdir(), "kobe-tab-strip-test-"))

const TABS: readonly TerminalTab[] = [
  { kind: "engine", id: "tab-1", title: null, ordinal: 1 },
  { kind: "engine", id: "tab-2", title: "a much longer engine tab title than fits", ordinal: 2 },
  { kind: "engine", id: "tab-3", title: null, ordinal: 3 },
]

function strip(activeId: string) {
  return (
    <TabStrip
      tabs={TABS}
      activeId={activeId}
      turnStates={new Map<string, ChatTabTurnState>([["tab-2", "running"]])}
      onSelect={() => {}}
      vendor="claude"
      liveTitles={new Map()}
      turnVendors={new Map()}
      worktree="/tmp/wt"
    />
  )
}

test("narrow strip shows the active tab truncated with a position counter", async () => {
  const { frame } = await renderComponent(strip("tab-2"), { width: 46, height: 4, providers: { kv: true } })
  const out = await frame()
  expect(out).toContain("2/3")
  // The long title is clipped with an ellipsis instead of wrapping.
  expect(out).toContain("…")
  expect(out).not.toContain("than fits")
})

test("desktop keeps the default mode gate (strip hidden)", async () => {
  const { frame } = await renderComponent(strip("tab-2"), { width: 100, height: 4, providers: { kv: true } })
  const out = await frame()
  expect(out).not.toContain("2/3")
})
