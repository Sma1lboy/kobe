/**
 * Queued user-initiated work pending dispatch when streaming ends.
 * Discriminated by `kind` so the chat shell can route the head item
 * to the right consumer: prompt -> engine, bash -> local subprocess.
 */
export type QueuedPrompt =
  | { readonly id: string; readonly kind: "prompt"; readonly text: string; readonly ts: string }
  | { readonly id: string; readonly kind: "bash"; readonly command: string; readonly ts: string }

type QueueState = {
  readonly queue: readonly QueuedPrompt[]
}

/**
 * Soft cap on queued prompts. Past this we reject further enqueues
 * with a system row instead of growing the queue without bound.
 */
export const QUEUE_SOFT_CAP = 50

function queueId(nowIso: string): string {
  return `q-${nowIso}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Append a prompt to the queue. Returns the same state when the queue
 * is full. Each entry gets a unique id so rendered queue actions can
 * address one row exactly.
 */
export function enqueuePrompt<S extends QueueState>(
  state: S,
  prompt: string,
  nowIso: string = new Date().toISOString(),
): S {
  if (state.queue.length >= QUEUE_SOFT_CAP) return state
  return {
    ...state,
    queue: [...state.queue, { id: queueId(nowIso), kind: "prompt", text: prompt, ts: nowIso }],
  }
}

/** Append a `!shell` command to the queue using the same FIFO + cap rules as prompts. */
export function enqueueBashCommand<S extends QueueState>(
  state: S,
  command: string,
  nowIso: string = new Date().toISOString(),
): S {
  if (state.queue.length >= QUEUE_SOFT_CAP) return state
  return {
    ...state,
    queue: [...state.queue, { id: queueId(nowIso), kind: "bash", command, ts: nowIso }],
  }
}

/** Whether the next enqueue would be refused. */
export function queueIsFull(state: QueueState): boolean {
  return state.queue.length >= QUEUE_SOFT_CAP
}

/**
 * Pop the head of the queue. Returns `[nextState, dequeued]`; both are
 * stable when the queue is empty.
 */
export function dequeueFirst<S extends QueueState>(state: S): [S, QueuedPrompt | null] {
  if (state.queue.length === 0) return [state, null]
  const [head, ...rest] = state.queue
  if (!head) return [state, null]
  return [{ ...state, queue: rest }, head]
}

/**
 * Replace the text of a queued prompt by id, keeping position, id, and
 * timestamp. Bash queue entries are intentionally not editable.
 */
export function updateQueueItem<S extends QueueState>(state: S, id: string, text: string): S {
  if (state.queue.length === 0) return state
  let changed = false
  const next = state.queue.map((q) => {
    if (q.id === id && q.kind === "prompt" && q.text !== text) {
      changed = true
      return { ...q, text }
    }
    return q
  })
  if (!changed) return state
  return { ...state, queue: next }
}

/** Remove a queued item by id. */
export function removeFromQueue<S extends QueueState>(state: S, id: string): S {
  if (state.queue.length === 0) return state
  const next = state.queue.filter((q) => q.id !== id)
  if (next.length === state.queue.length) return state
  return { ...state, queue: next }
}

/** Wipe the queue. */
export function clearQueue<S extends QueueState>(state: S): S {
  if (state.queue.length === 0) return state
  return { ...state, queue: [] }
}
