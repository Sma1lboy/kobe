import { coerceVendorId } from "@/types/vendor"
import { startHistoryHost } from "../history/host"
import { MOCK_HISTORY_WORKTREE, createMockHistoryReader } from "../history/mock-fixtures"

export async function startMockHost(): Promise<void> {
  await startHistoryHost({
    worktree: MOCK_HISTORY_WORKTREE,
    vendor: coerceVendorId("claude"),
    live: true,
    reader: createMockHistoryReader(),
  })
}

void startMockHost()
