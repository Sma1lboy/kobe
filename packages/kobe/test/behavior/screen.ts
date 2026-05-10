/**
 * ANSI screen parser for behavior tests.
 *
 * The TUI under test (kobe) emits a torrent of ANSI escape sequences:
 * cursor positioning, color codes, alt-screen toggles, OSC title sets,
 * mouse-mode toggles, and more. For human-readable assertions
 * (`expect(screen).toContain("kobe")`) we need plain text.
 *
 * The strategy:
 *   1. Strip every ANSI / OSC / DCS / control-byte sequence.
 *   2. Apply a few well-known carriage-return / cursor-positioning
 *      heuristics so multi-line content stays on separate lines.
 *   3. Normalize whitespace into something a `toContain` can match.
 *
 * We deliberately do NOT build a full VT emulator. That's overkill for
 * "is `kobe` visible somewhere on screen?" assertions. If a future test
 * needs precise pane geometry, we can swap to a real emulator (xterm.js
 * has a headless mode) without changing the public `KobeHandle` API.
 */

/**
 * Strip ANSI escape sequences from a string while preserving printable
 * text and line breaks. Hand-rolled to avoid pulling another dep; the
 * grammar is small and stable.
 *
 * Covers:
 *   - CSI sequences: ESC [ ... letter (cursor moves, colors, modes)
 *   - OSC sequences: ESC ] ... BEL or ESC \  (titles, hyperlinks)
 *   - DCS / SOS / PM / APC: ESC P/X/^/_ ... ESC \
 *   - Single-character ESC sequences (ESC =, ESC >, etc.)
 *   - Bare control bytes other than \n \r \t
 */
export function stripAnsi(input: string): string {
  let out = ""
  let i = 0
  const n = input.length
  while (i < n) {
    const ch = input[i]
    const code = input.charCodeAt(i)

    // ESC: start of an escape sequence.
    if (ch === "\x1b") {
      const next = input[i + 1]
      // CSI: ESC [ ... final-byte (0x40–0x7e)
      if (next === "[") {
        i += 2
        // params + intermediates
        while (i < n) {
          const c = input.charCodeAt(i)
          if (c >= 0x40 && c <= 0x7e) {
            i += 1
            break
          }
          i += 1
        }
        continue
      }
      // OSC: ESC ] ... terminator (BEL or ESC \)
      if (next === "]") {
        i += 2
        while (i < n) {
          const c = input[i]
          if (c === "\x07") {
            i += 1
            break
          }
          if (c === "\x1b" && input[i + 1] === "\\") {
            i += 2
            break
          }
          i += 1
        }
        continue
      }
      // DCS / SOS / PM / APC: ESC P/X/^/_ ... ST (ESC \)
      if (next === "P" || next === "X" || next === "^" || next === "_") {
        i += 2
        while (i < n) {
          const c = input[i]
          if (c === "\x1b" && input[i + 1] === "\\") {
            i += 2
            break
          }
          i += 1
        }
        continue
      }
      // Two-byte sequences (ESC = , ESC >, ESC c, ESC 7, ESC 8, ...)
      // Skip just ESC + the next char.
      i += 2
      continue
    }

    // Allowed whitespace passthrough.
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      out += ch
      i += 1
      continue
    }

    // Drop other C0/C1 control bytes (BEL, BS, etc.).
    if (code < 0x20 || code === 0x7f) {
      i += 1
      continue
    }

    out += ch
    i += 1
  }
  return out
}

/**
 * Best-effort flattening: many TUIs paint by jumping the cursor
 * around, so the raw stream has lines glued back-to-back. We split
 * on `\n` and `\r`, drop empties at the edges, and trim trailing
 * spaces on each line.
 *
 * Returns a single string with `\n` separators — friendly for
 * `toContain` and `toMatch`.
 */
export function normalizeScreen(raw: string): string {
  const stripped = stripAnsi(raw)
  // Split on either CR or LF; collapse runs of newline into one.
  const lines = stripped.split(/\r\n|\r|\n/).map((l) => l.replace(/\s+$/u, ""))
  // Trim leading + trailing fully-empty lines.
  while (lines.length > 0 && lines[0] === "") lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines.join("\n")
}
