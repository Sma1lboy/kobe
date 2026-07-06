/** @jsxImportSource @opentui/react */
/**
 * React history-pane mock host. It renders the ported pane against the exact
 * fake EngineHistoryReader fixtures used by the Solid `dev:mock` smoke.
 */

import { MOCK_HISTORY_WORKTREE, createMockHistoryReader } from "../../tui/history/mock-fixtures"
import { coerceVendorId } from "../../types/vendor"
import { startHistoryHost } from "./host"

await startHistoryHost({
  worktree: MOCK_HISTORY_WORKTREE,
  vendor: coerceVendorId("claude"),
  live: true,
  reader: createMockHistoryReader(),
})
