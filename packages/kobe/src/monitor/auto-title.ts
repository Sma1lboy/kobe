import { engineEntry } from "@/engine/registry"
import { deriveTitleFromPrompt } from "@/orchestrator/title"
import type { Message } from "@/types/engine"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"

const MAX_SESSIONS_SCANNED = 8

function titleFromMessages(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser) return ""
  const text = firstUser.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join(" ")
  const title = deriveTitleFromPrompt(text)
  return title.length > 0 ? Buffer.from(title, "utf8").toString("utf8") : title
}

export async function deriveTitleFromSession(
  worktree: string,
  vendor: VendorId = DEFAULT_TASK_VENDOR,
): Promise<string> {
  if (!worktree) return ""
  const { history } = engineEntry(vendor)
  const ids = await history.listSessionIdsForWorktree(worktree)
  for (const sessionId of ids.slice(0, MAX_SESSIONS_SCANNED)) {
    const title = titleFromMessages(await history.readHistory(sessionId))
    if (title) return title
  }
  return ""
}

export async function deriveTitleFromSessionId(vendor: VendorId, sessionId: string): Promise<string> {
  if (!sessionId) return ""
  try {
    return titleFromMessages(await engineEntry(vendor).history.readHistory(sessionId))
  } catch {
    return ""
  }
}
