/**
 * Custom keybindings for the chat composer's `<textarea>`.
 *
 * Why we override the defaults:
 *
 * opentui's {@link defaultTextareaKeyBindings} (in
 * `node_modules/@opentui/core/index-*.js`) maps `return` → `newline`
 * and `meta+return` → `submit`. That matches a code editor's
 * conventions but NOT a chat composer — Claude Code, Cursor, Slack,
 * Discord, and every other prompt UI we're modeling treat plain enter
 * as "send" and shift+enter as "newline." So we flip:
 *
 *   - `enter` (return)            → submit
 *   - `shift+enter`               → newline   (kitty / CSI-u terminals)
 *   - `linefeed` (Ctrl+J / 0x0A)  → newline   (fallback for terminals
 *                                              that don't distinguish
 *                                              shift+enter from plain
 *                                              enter — most don't)
 *
 * Note on terminal capability:
 *
 *   Most terminals (Terminal.app, gnome-terminal, default tmux) send
 *   the same byte (`\r`) for plain enter and shift+enter. Only kitty,
 *   foot, and a handful of others implement the kitty-keyboard /
 *   CSI-u protocol that lets us tell them apart. opentui's renderer
 *   probes for this support at startup; if available, we get
 *   `shift: true` on the key event. If not, the user can still get a
 *   newline via Ctrl+J. Both bindings live below.
 *
 * Up/down arrow handling for prompt history is NOT in this map — that
 * lives in the composer's `onKeyDown` handler, which preventDefault's
 * the textarea's own up/down ONLY when the cursor is at the top /
 * bottom of the buffer. Putting it in keyBindings would steal the
 * keys mid-buffer too, breaking multi-line cursor navigation.
 */

import type { TextareaProps } from "@opentui/solid"

/**
 * Type alias for the array shape `<textarea keyBindings={...}>` expects.
 * Defined inline so we don't depend on opentui's internal exports — the
 * shape is just `{ name, ctrl?, shift?, meta?, super?, action }`.
 */
type Binding = NonNullable<TextareaProps["keyBindings"]>[number]

/**
 * Keybindings the composer pushes into `<textarea keyBindings={...}>`.
 *
 * Custom bindings get merged on TOP of opentui's defaults — this list
 * replaces only the keys we re-target. Everything else (arrow keys,
 * undo/redo, word movement, line edits, paste) keeps the default
 * behavior.
 */
export const composerKeyBindings: Binding[] = [
  // Plain enter → submit (overrides default `return → newline`).
  { name: "return", action: "submit" },
  // Shift+enter → newline. Only fires in terminals that report the
  // shift modifier on enter (kitty / CSI-u). On other terminals this
  // binding is dead — the user uses Ctrl+J (linefeed) instead.
  { name: "return", shift: true, action: "newline" },
  // Ctrl+J / 0x0A → newline. The terminal-agnostic way to insert a
  // newline at the cursor. Default already maps `linefeed → newline`,
  // we restate it for clarity (the override-merge would no-op).
  { name: "linefeed", action: "newline" },
]
