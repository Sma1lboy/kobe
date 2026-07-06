/** @jsxImportSource @opentui/react */

import { MOCK_HISTORY_WORKTREE, createMockHistoryReader } from "../../tui/history/mock-fixtures"
import { coerceVendorId } from "../../types/vendor"
import { startHistoryHost } from "./host"

await startHistoryHost({
  worktree: MOCK_HISTORY_WORKTREE,
  vendor: coerceVendorId("claude"),
  live: true,
  reader: createMockHistoryReader(),
})
