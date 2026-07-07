/** @jsxImportSource @opentui/react */
/**
 * React terminal-pane mock host (`bun run dev:mock-react-terminal`) — the
 * live render proof for the ported pane (issue #16 React migration).
 * Backs the PTY with `MockTaskPty` (no real shell spawned) so the mount
 * is deterministic: `feed()` pushes ANSI/text as if a shell had printed
 * it, proving the SGR→StyledText render path without a live process.
 *
 * Not interactive by design (`MockTaskPty.write` only records writes, it
 * doesn't echo) — this mock exists to eyeball layout/scrollback/theme,
 * not to drive a real shell. Ctrl+pgup/pgdn scrolls the seeded backlog;
 * q / ctrl+c quits.
 */

import { MockTaskPty } from "../../../tui/panes/terminal/pty-mock"
import { PtyRegistry } from "../../../tui/panes/terminal/registry"
import { bootPaneHost } from "../../lib/host-boot"
import { useBindings } from "../../lib/keymap"
import { Terminal } from "./Terminal"

const MOCK_TASK_ID = "mock-task"
const MOCK_CWD = "/tmp/kobe-terminal-mock"
const MOCK_ROWS = 24
const MOCK_COLS = 80

function seedMockPty(): MockTaskPty {
  const pty = new MockTaskPty({ taskId: MOCK_TASK_ID, cwd: MOCK_CWD, cols: MOCK_COLS, rows: MOCK_ROWS })
  const lines = [
    "\x1b[1;32mkobe terminal pane — React mock\x1b[0m",
    "not interactive (MockTaskPty doesn't echo); ctrl+pgup/pgdn scrolls the seeded backlog.",
    "",
  ]
  // Pad past one screenful so ctrl+pgup has real scrollback to move through.
  for (let i = 1; i <= MOCK_ROWS + 10; i++) lines.push(`line ${i}: \x1b[36msample output\x1b[0m for scrollback testing`)
  lines.push("$ ")
  pty.feed(lines.join("\r\n"))
  return pty
}

function MockTerminalScreen(props: { registry: PtyRegistry }) {
  useBindings(() => ({
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
    ],
  }))

  return <Terminal cwd={MOCK_CWD} taskId={MOCK_TASK_ID} focused={true} registry={props.registry} />
}

await bootPaneHost({
  logContext: "terminal-mock",
  setup: () => {
    const mockPty = seedMockPty()
    // Same instance for every acquire — the mock isn't task-keyed, it
    // exists purely to back this one pane mount.
    const registry = new PtyRegistry(() => mockPty)
    return { root: () => <MockTerminalScreen registry={registry} /> }
  },
})
