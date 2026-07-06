import { api } from "./api-client.ts"

export async function fetchNotes(taskId: string): Promise<string> {
  const data = await api.get<{ markdown?: string }>("/api/notes", {
    query: { taskId },
    label: "load notes",
  })
  return data.markdown ?? ""
}

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
