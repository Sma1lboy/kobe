/**
 * Bounded scrollback ring for the PTY server.
 *
 * The web terminal replays recent output on every (re)attach, so each PTY keeps
 * a cap of recent bytes. The naive shape — `buffer = (buffer + data).slice(-CAP)`
 * on every chunk — re-flattens the whole ~256KB buffer per chunk once full, so a
 * burst of N small chunks costs O(N·CAP) (quadratic) on the same thread that
 * relays bytes to the browser.
 *
 * This ring keeps the chunks as-is and a running length total: `push` is
 * O(chunk) (append + shift whole chunks off the head until back under the cap),
 * and the string is materialized only on `replay` — once per attach, O(cap).
 *
 * "Length" is measured in JS string length (UTF-16 code units), matching the
 * prior `.slice(-CAP)` semantics: the cap is an approximate recent-output
 * window, not an exact byte count.
 */

/**
 * @param {number} cap Max retained length (string code units).
 * @returns {{ push: (data: string) => void, replay: () => string, length: () => number, chunkCount: () => number }}
 */
export function createScrollback(cap) {
  /** @type {string[]} */
  let chunks = []
  let total = 0

  return {
    push(data) {
      if (!data) return
      chunks.push(data)
      total += data.length
      // Drop whole chunks off the head while over cap, but always keep the
      // most recent chunk so a single oversized chunk still replays.
      while (total > cap && chunks.length > 1) {
        const dropped = chunks.shift()
        total -= dropped.length
      }
    },
    replay() {
      if (chunks.length === 0) return ""
      return chunks.length === 1 ? chunks[0] : chunks.join("")
    },
    length() {
      return total
    },
    chunkCount() {
      return chunks.length
    },
  }
}
