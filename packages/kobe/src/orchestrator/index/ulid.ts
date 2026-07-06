/**
 * Minimal Crockford-base32 ULID implementation.
 *
 * A ULID is a 26-character, lexicographically sortable identifier:
 *   - 10 chars of 48-bit timestamp (ms since epoch), high-order first.
 *   - 16 chars of 80-bit randomness.
 *
 * Two properties matter for kobe's task index:
 *
 *   1. **Lex-sortable by creation time** — `Task.id` doubles as a
 *      "created at" tiebreaker. Sidebar grouping/ordering can rely on
 *      string compare instead of parsing `createdAt`.
 *
 *   2. **Monotonic within the same millisecond** — when two tasks are
 *      created back-to-back, the second must sort *after* the first.
 *      We achieve this by remembering the last (timestamp, randomness)
 *      we emitted: if the same millisecond comes around again, we
 *      increment the previous random tail by one instead of generating
 *      fresh randomness. (Spec: github.com/ulid/spec — "Monotonicity".)
 *
 * Inlined intentionally (~80 LoC, no deps). If we ever need a battle-
 * tested impl, swap to the `ulid` npm package — the public surface
 * here is just `ulid()` so the swap is trivial.
 */

/** Crockford base32 alphabet — no I, L, O, U to avoid ambiguity. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const TIME_LEN = 10
const RAND_LEN = 16

/** Last emitted (timestamp_ms, encoded random tail). Drives monotonicity. */
let lastTime = -1
let lastRand: number[] = new Array(RAND_LEN).fill(0)

/**
 * Encode an integer into `len` chars of the Crockford alphabet, MSB first.
 * Used only for the timestamp half (≤ 48 bits, fits in a JS number).
 */
function encodeTime(now: number, len: number): string {
  let out = ""
  let n = now
  for (let i = len - 1; i >= 0; i--) {
    const mod = n % 32
    out = ALPHABET[mod] + out
    n = (n - mod) / 32
  }
  return out
}

/** Generate `len` cryptographically random Crockford-alphabet indices. */
function randomIndices(len: number): number[] {
  const buf = new Uint8Array(len)
  crypto.getRandomValues(buf)
  // Map each byte into [0, 32) by masking the top three bits. The spec
  // doesn't require uniform sampling and the bias is negligible (the
  // alphabet is exactly 32 = 2^5, so masking is uniform anyway).
  const out: number[] = new Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = (buf[i] ?? 0) & 0x1f
  }
  return out
}

/** Increment a base-32 indices array in place. Returns false on overflow. */
function incrementIndices(indices: number[]): boolean {
  for (let i = indices.length - 1; i >= 0; i--) {
    const v = indices[i] ?? 0
    if (v < 31) {
      indices[i] = v + 1
      return true
    }
    indices[i] = 0
  }
  // Pathological: all 16 chars were "Z". Caller will regenerate randomness.
  return false
}

function indicesToString(indices: number[]): string {
  let out = ""
  for (const idx of indices) {
    out += ALPHABET[idx] ?? "0"
  }
  return out
}

/**
 * Generate a fresh ULID.
 *
 * @param now Optional timestamp override (ms). Tests inject this to make
 *   monotonicity assertions deterministic. Defaults to `Date.now()`.
 */
export function ulid(now: number = Date.now()): string {
  let randIndices: number[]
  if (now === lastTime) {
    // Same millisecond: increment the previous tail to preserve
    // strict monotonic ordering across same-ms calls.
    const next = lastRand.slice()
    if (!incrementIndices(next)) {
      // Astronomically unlikely (16 Z's). Fall back to fresh randomness.
      randIndices = randomIndices(RAND_LEN)
    } else {
      randIndices = next
    }
  } else {
    randIndices = randomIndices(RAND_LEN)
  }
  lastTime = now
  lastRand = randIndices
  return encodeTime(now, TIME_LEN) + indicesToString(randIndices)
}

/** Reset the monotonic state — exported for tests only. */
export function _resetUlidStateForTests(): void {
  lastTime = -1
  lastRand = new Array(RAND_LEN).fill(0)
}

/** The Crockford base32 alphabet — exported for test assertions. */
export const ULID_ALPHABET = ALPHABET
