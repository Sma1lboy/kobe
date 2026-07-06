import { getPersistedBool, setPersistedBool } from "./store.ts"

const previewModeKey = (taskId: string): string => `preview.${taskId}`

export function previewModeEnabled(taskId: string): boolean {
  return getPersistedBool(previewModeKey(taskId), false)
}

export function togglePreviewMode(taskId: string): boolean {
  const next = !previewModeEnabled(taskId)
  setPersistedBool(previewModeKey(taskId), next)
  return next
}
