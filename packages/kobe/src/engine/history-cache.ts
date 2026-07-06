import { createHash } from "node:crypto"
import type { Message } from "@/types/engine"

export interface AppendParseCacheOptions<S, C> {
  initial: (ctx: C) => S
  parseChunk: (chunk: string, prev: S, ctx: C) => S
  maxFiles?: number
}

interface CacheEntry<S> {
  prefixLength: number
  prefixHash: string
  state: S
}

export function createAppendParseCache<S, C = void>(
  opts: AppendParseCacheOptions<S, C>,
): (filePath: string, raw: string, ctx: C) => S {
  const maxFiles = opts.maxFiles ?? 8
  const cache = new Map<string, CacheEntry<S>>()

  function hashPrefix(raw: string, length: number): string {
    return createHash("sha256").update(raw.slice(0, length)).digest("hex")
  }

  function remember(filePath: string, entry: CacheEntry<S>): void {
    cache.delete(filePath)
    cache.set(filePath, entry)
    if (cache.size > maxFiles) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
  }

  return function parseCached(filePath: string, raw: string, ctx: C): S {
    const stableLength = raw.lastIndexOf("\n") + 1
    const entry = cache.get(filePath)

    let prefixState: S
    if (entry && entry.prefixLength <= stableLength && hashPrefix(raw, entry.prefixLength) === entry.prefixHash) {
      prefixState =
        entry.prefixLength < stableLength
          ? opts.parseChunk(raw.slice(entry.prefixLength, stableLength), entry.state, ctx)
          : entry.state
    } else {
      prefixState = opts.parseChunk(raw.slice(0, stableLength), opts.initial(ctx), ctx)
    }

    if (!entry || entry.prefixLength !== stableLength || entry.state !== prefixState) {
      remember(filePath, {
        prefixLength: stableLength,
        prefixHash: hashPrefix(raw, stableLength),
        state: prefixState,
      })
    }

    const tail = raw.slice(stableLength)
    return tail.trim().length > 0 ? opts.parseChunk(tail, prefixState, ctx) : prefixState
  }
}

export function sortByTimestamp(messages: readonly Message[]): Message[] {
  return messages
    .map((msg, idx) => ({ msg, idx }))
    .sort((a, b) => {
      if (a.msg.timestamp < b.msg.timestamp) return -1
      if (a.msg.timestamp > b.msg.timestamp) return 1
      return a.idx - b.idx
    })
    .map((entry) => entry.msg)
}
