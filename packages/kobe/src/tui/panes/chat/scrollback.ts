import type { ChatRow } from "./store"

export const SCROLLBACK_CAP = 1000

const SENTINEL_PREFIX = "(scrollback truncated — "
const SENTINEL_SUFFIX = " rows dropped)"

function sentinelText(n: number): string {
  return `${SENTINEL_PREFIX}${n}${SENTINEL_SUFFIX}`
}

function parseSentinelCount(text: string): number | null {
  if (!text.startsWith(SENTINEL_PREFIX) || !text.endsWith(SENTINEL_SUFFIX)) return null
  const middle = text.slice(SENTINEL_PREFIX.length, text.length - SENTINEL_SUFFIX.length)
  const n = Number.parseInt(middle, 10)
  return Number.isFinite(n) && n >= 0 && String(n) === middle ? n : null
}

export function capMessages(messages: readonly ChatRow[], nowIso: string): readonly ChatRow[] {
  if (messages.length <= SCROLLBACK_CAP) return messages

  const head = messages[0]
  const existingDropped = head && head.kind === "system" ? parseSentinelCount(head.text) : null
  const reserveSentinel = 1
  const start = messages.length - (SCROLLBACK_CAP - reserveSentinel)
  const tail = messages.slice(Math.max(start, existingDropped !== null ? 1 : 0))
  const droppedThisCall = existingDropped !== null ? Math.max(0, start - 1) : Math.max(0, start)
  const totalDropped = (existingDropped ?? 0) + droppedThisCall
  const sentinelTs = existingDropped !== null && head ? head.ts : nowIso
  const sentinel: ChatRow = { kind: "system", text: sentinelText(totalDropped), ts: sentinelTs }
  return [sentinel, ...tail]
}
