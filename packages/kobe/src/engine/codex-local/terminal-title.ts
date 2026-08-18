/**
 * Codex's OSC-title knowledge — what its `tui.terminal_title` segments
 * actually put on the wire, kept in the adapter that owns the vendor rather
 * than in the neutral registry/TUI layers.
 *
 * Rove launches codex with `-c tui.terminal_title=["activity","thread-title"]`
 * so a tab wears its conversation instead of the repo name. But codex
 * documents that segment as "the current thread title, OR the thread
 * identifier when unnamed" — and a thread stays unnamed until codex names
 * it, so in practice a fresh session reports a bare UUID
 * (`01a00ee9-f0e9-7503-a11c-83b4eface0f6`, observed on a live 0.147 session).
 * That is an id, not a label, and Rove must not render it as one.
 *
 * It is still the most useful thing codex could have written: it names the
 * rollout in `~/.codex/sessions/**`, which is where the conversation's first
 * prompt lives. So the rule below is exposed as an id EXTRACTOR — the engine
 * contract (`EngineTerminalTitle.sessionIdFromTitle`) reads a non-null answer
 * as both "don't show this" and "name the tab from this session instead".
 */

/**
 * Codex thread ids are UUIDs (v7 in current builds — the version nibble is
 * deliberately not pinned, only the shape). Anchored and whole-string: a
 * NAMED thread whose title merely contains a uuid is still a name.
 */
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The codex thread id this OSC title IS, or null when the title is a real
 * thread name (once codex names the thread, that name wins — the fallback
 * heals itself with no further signal). The caller has already stripped
 * codex's spinner prefix; this is defensive about surrounding whitespace
 * only.
 */
export function codexSessionIdFromTitle(title: string): string | null {
  const trimmed = title.trim()
  return CODEX_THREAD_ID.test(trimmed) ? trimmed.toLowerCase() : null
}
