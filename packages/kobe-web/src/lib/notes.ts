/**
 * Notes API client — talks to the bridge's /api/notes routes (see
 * packages/kobe/src/web/notes.ts). Web-only feature: free-form markdown
 * notes persisted server-side, one file per task.
 */

import { api } from "./api-client.ts"

/** Load the saved markdown for a task. Returns "" if none exists yet. */
export async function fetchNotes(taskId: string): Promise<string> {
  const data = await api.get<{ markdown?: string }>("/api/notes", {
    query: { taskId },
    label: "load notes",
  })
  return data.markdown ?? ""
}

/** Persist the markdown for a task. */
export async function saveNotes(
  taskId: string,
  markdown: string,
): Promise<void> {
  await api.put<void>(
    "/api/notes",
    { taskId, markdown },
    { label: "save notes" },
  )
}
