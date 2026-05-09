/**
 * Terminal pane public surface (Stream J).
 *
 * Mirrors the sidebar pane's barrel pattern: orchestrator (Stream E)
 * imports `Terminal` from here. Tests should NOT import the JSX
 * component from this barrel — the JSX import drags in `@opentui/core`
 * which requires the Bun runtime, while vitest runs under Node. Tests
 * should import the pure logic modules directly:
 *
 *   import { PtyRegistry } from "@/tui/panes/terminal/registry"
 *   import { keyEventToShellBytes } from "@/tui/panes/terminal/keys"
 *   import { MockTaskPty } from "@/tui/panes/terminal/pty"
 *
 * The behavior test (`test/behavior/terminal.test.ts`) is the only
 * place the rendered component is exercised — there it goes through
 * the real Bun + opentui runtime.
 */

export {
  Terminal,
  _resetDefaultPtyRegistry,
  getDefaultPtyRegistry,
  type TerminalProps,
} from "./Terminal"
export { useTerminalBindings } from "./keys"
export { DEFAULT_PAGE_SIZE, PASSTHROUGH_NAMES, TRAPPED_KEYS, keyEventToShellBytes } from "./keys-pure"
export {
  MockTaskPty,
  TmuxTaskPty,
  type TaskPty,
  type TaskPtyLike,
  type TaskPtyOpts,
  createTaskPty,
} from "./pty"
export { PtyRegistry, type PtyFactory, type AcquireOpts } from "./registry"
