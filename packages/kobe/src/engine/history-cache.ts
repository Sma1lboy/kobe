/**
 * Append-aware per-file transcript parse cache, shared by the engine
 * history readers (claude-code-local, codex-local, copilot-local).
 *
 * Why it exists: the history pane polls transcript mtime and re-reads the
 * file every ~2.5s. A full re-parse builds a completely fresh `Message[]`
 * with new object identities each call — Solid's `<For>` keys rows by
 * reference, so all-new identities destroy + recreate every rendered row's
 * native subtree per poll, and the re-parse itself is O(n²) allocation over
 * a session's lifetime. Transcripts are append-only in the common case, so
 * we cache the parsed prefix and only parse the appended slice, returning
 * the SAME object refs for already-seen records.
 *
 * Soundness: the cache boundary always sits on a `\n` so a partially
 * flushed trailing line is never split across prefix/suffix — the
 * un-terminated tail is re-parsed fresh every call and never cached.
 * Rewrite/truncation (compaction, resume-branch rewrites) is detected by
 * validating the cached prefix: previous prefix length + a SHA-256 of that
 * prefix (we never retain the previous file content itself). Any mismatch
 * falls back to a full re-parse and replaces the cache entry.
 *
 * Vendors with cross-line parse state (copilot's session.start id /
 * tool-name map) cache that state alongside the messages: `S` is whatever
 * fold state the vendor's `parseChunk` threads through.
 */

import { createHash } from "node:crypto"
import type { Message } from "@/types/engine"

export interface AppendParseCacheOptions<S, C> {
  /** Fold state for an empty transcript (before any complete line). */
  initial: (ctx: C) => S
  /**
   * Fold a chunk of transcript lines onto `prev`, returning NEW state
   * WITHOUT mutating `prev` — the cached prefix state is shared across
   * calls (clone arrays/maps before appending). Must fold associatively
   * over line boundaries: `parseChunk(b, parseChunk(a, s))` must equal
   * `parseChunk(a + b, s)` when `a` ends at a `\n`, so a cached prefix
   * can be extended one appended slice at a time.
   */
  parseChunk: (chunk: string, prev: S, ctx: C) => S
  /** FIFO cap on cached files (default 8). */
  maxFiles?: number
}

interface CacheEntry<S> {
  /** Char length of the cached prefix — always ends at a `\n` boundary. */
  prefixLength: number
  /** SHA-256 hex of `raw.slice(0, prefixLength)` at cache time. */
  prefixHash: string
  /** Fold state over that prefix (messages + any vendor carry-over). */
  state: S
}

/**
 * Create a per-file append-aware parse cache. Call the returned function
 * with the full current contents of `filePath`; it reuses the cached fold
 * of the unchanged prefix when the file only appended since the last call,
 * so objects for already-seen records keep their identity across calls.
 */
export function createAppendParseCache<S, C = void>(
  opts: AppendParseCacheOptions<S, C>,
): (filePath: string, raw: string, ctx: C) => S {
  // ponytail: FIFO cap, not LRU — a pane process only ever polls a handful
  // of session files; switch to LRU if panes start juggling many sessions.
  const maxFiles = opts.maxFiles ?? 8
  const cache = new Map<string, CacheEntry<S>>()

  function hashPrefix(raw: string, length: number): string {
    return createHash("sha256").update(raw.slice(0, length)).digest("hex")
  }

  function remember(filePath: string, entry: CacheEntry<S>): void {
    cache.delete(filePath) // re-insert so Map order tracks recency of writes
    cache.set(filePath, entry)
    if (cache.size > maxFiles) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
  }

  return function parseCached(filePath: string, raw: string, ctx: C): S {
    // Complete-line boundary: everything past the last `\n` may be a
    // partially flushed record — parse it fresh each call, never cache it.
    const stableLength = raw.lastIndexOf("\n") + 1
    const entry = cache.get(filePath)

    let prefixState: S
    if (entry && entry.prefixLength <= stableLength && hashPrefix(raw, entry.prefixLength) === entry.prefixHash) {
      // Append-only since last read: fold just the new complete lines.
      prefixState =
        entry.prefixLength < stableLength
          ? opts.parseChunk(raw.slice(entry.prefixLength, stableLength), entry.state, ctx)
          : entry.state
    } else {
      // First read, rewrite, or truncation: full re-fold of the stable prefix.
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

/**
 * Sort messages by their `timestamp` ASC (oldest first → newest last).
 *
 * Vendor transcripts aren't strictly chronological in file order (e.g.
 * Claude's JSONL is a DAG — records carry `parentUuid` for branching
 * resumes, so a resumed session can interleave records from different
 * branches). The chat pane relies on `past[]` being chronological so
 * newest messages render at the bottom; readers sort at the engine
 * boundary so every consumer gets the same shape.
 *
 * Stable sort: ties (same ISO timestamp) keep file-order, which roughly
 * preserves causal ordering even at sub-millisecond ties.
 */
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
