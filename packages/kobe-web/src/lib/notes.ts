/**
 * Notes API client — talks to the bridge's /api/notes routes (see
 * packages/kobe/src/web/notes.ts). Web-only feature: free-form markdown
 * notes persisted server-side, one file per task.
 */

/** Load the saved markdown for a task. Returns "" if none exists yet. */
export async function fetchNotes(taskId: string): Promise<string> {
  const res = await fetch(`/api/notes?taskId=${encodeURIComponent(taskId)}`)
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`failed to load notes (${res.status})${detail ? `: ${detail}` : ""}`)
  }
  const data = (await res.json()) as { markdown?: string }
  return data.markdown ?? ""
}

/** Persist the markdown for a task. */
export async function saveNotes(taskId: string, markdown: string): Promise<void> {
  const res = await fetch("/api/notes", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId, markdown }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`failed to save notes (${res.status})${detail ? `: ${detail}` : ""}`)
  }
}
