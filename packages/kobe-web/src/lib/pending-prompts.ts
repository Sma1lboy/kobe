/**
 * A first prompt to seed into a freshly-created task's engine composer.
 * Not persisted — a one-shot, consumed by the first engine ChatTerminal that
 * mounts for the task. (No PTY-readiness timing games: it pre-fills the
 * composer draft so the user sends when the engine is ready.)
 */
const pendingPrompts = new Map<string, string>()

export function setPendingPrompt(taskId: string, prompt: string): void {
  pendingPrompts.set(taskId, prompt)
}

export function consumePendingPrompt(taskId: string): string | null {
  const prompt = pendingPrompts.get(taskId)
  if (prompt === undefined) return null
  pendingPrompts.delete(taskId)
  return prompt
}
