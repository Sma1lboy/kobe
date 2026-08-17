/**
 * Engine-owned OSC-title policy — the vocabulary an engine declares about
 * the titles it writes, plus the pure matchers neutral layers judge a live
 * title by.
 *
 * Split out of `registry.ts` (file-size cap) and deliberately REGISTRY-FREE:
 * everything here takes the declared vocabulary as an argument, so it holds
 * no import cycle back to the entry table. `registry.ts` owns the thin
 * vendor-resolving wrappers (`stripEngineStatusPrefix`, `engineDisplayTitle`,
 * `engineTitleTurnHint`) and re-exports the type; call those, not these.
 *
 * The shape of the problem: an engine that owns its terminal title writes
 * TWO things into it that are not the conversation's name — a status
 * decoration (claude's `✳`, codex's braille spinner) and, for some engines,
 * an internal IDENTIFIER when it has no name to show (codex writes the
 * thread UUID). Both must be recognized WITHOUT any neutral layer learning a
 * vendor's spelling, which is what {@link EngineTerminalTitlePolicy}
 * declares and what the matchers below consume.
 */

/**
 * Native OSC 0/2 title policy for an engine's interactive terminal sessions.
 * Declared per engine in the registry; every field is optional except
 * `ownsStatus`, and an engine that writes a plain, undecorated title declares
 * nothing but that.
 */
export interface EngineTerminalTitlePolicy {
  /**
   * The engine's live title is the status surface while it is visible, so
   * neutral tab chrome must not prefix a duplicate turn glyph.
   */
  readonly ownsStatus: boolean
  /**
   * Extra launch argv that selects the engine's own title fields, so the
   * launcher never learns a vendor's config syntax.
   */
  readonly launchArgs?: readonly string[]
  /**
   * Leading STATUS decoration the engine writes into its own OSC title,
   * stripped before kobe renders the name. Engine-owned by construction:
   * only the adapter knows its vendor's glyph vocabulary, and kobe already
   * draws that state in its own column — showing both is the same fact
   * twice, and the animated variants make a resting tab look busy.
   *
   * Matched anchored at the start, longest-first, with any following
   * whitespace; the remainder is the title. A pattern that would consume
   * the WHOLE title is not applied (a session actually named "Working" is
   * a name, not a status).
   */
  readonly statusPrefixes?: readonly string[]
  /**
   * The subset of {@link statusPrefixes} the engine ONLY writes while a
   * turn is running (its animated frames). A title that stops starting
   * with one of these is the engine's own "I stopped working" signal —
   * the one observable event an ESC interrupt leaves behind (claude-code
   * runs no Stop hook on its abort path; issue #15). Consumed by
   * `engineTitleTurnHint`. Omit when the engine's resting title is
   * indistinguishable from its working one.
   */
  readonly workingPrefixes?: readonly string[]
  /**
   * Titles this engine writes that are an INTERNAL IDENTIFIER rather than a
   * name — matched against the title with its status decoration already
   * stripped. A match means "this engine has no name for the session", so
   * neutral layers treat it as no live title at all and fall through to
   * kobe's own rungs (the recorded name, the first-prompt summary, the
   * numbered vendor default) instead of painting the identifier.
   *
   * The one place a vendor's placeholder SPELLING is allowed to live. Codex
   * is the case that forced it: its `thread-title` segment renders the
   * thread UUID (`01a00ea6-79cb-…`) for every session that has no
   * user-assigned name, which is all of them — verified against
   * codex-cli 0.147 on both a fresh session and a resumed one that already
   * had a stored title. Other engines will have their own shapes (a bare
   * pid, an "Untitled", a cwd echo), which is why this is declared data and
   * not a codex branch in the renderer.
   *
   * Patterns MUST be anchored (`^…$`) and MUST NOT carry the `g` flag —
   * `RegExp.test` on a global regex is stateful and would match every other
   * call. Tested against the TRIMMED title.
   */
  readonly placeholderTitles?: readonly RegExp[]
}

/**
 * Strip a leading status decoration from `title` using `prefixes`.
 *
 * Longest-first so a multi-char prefix isn't shadowed by a shorter one, and
 * conservative where it matters: a prefix that would consume the whole title
 * is returned unchanged, so a session genuinely named after one of these
 * glyphs keeps its name.
 */
export function stripStatusPrefix(title: string, prefixes: readonly string[]): string {
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    if (!title.startsWith(prefix)) continue
    const rest = title.slice(prefix.length).trimStart()
    // Whole title was the decoration → it is the name, not a status.
    if (rest.length === 0) return title
    return rest
  }
  return title
}

/**
 * True when `title` is one of the engine's identifier placeholders — i.e.
 * the engine wrote something that is not a name. An empty title answers
 * false: "nothing reported yet" is a different fact from "reported an id",
 * and the callers already treat empty as absent.
 */
export function isPlaceholderTitle(title: string, patterns: readonly RegExp[]): boolean {
  const trimmed = title.trim()
  if (trimmed.length === 0) return false
  return patterns.some((pattern) => pattern.test(trimmed))
}

/**
 * What a status-owning engine's live title says about its turn state, or
 * `null` when the title carries no verdict.
 *
 * Strict on purpose: `"rest"` is only claimed for a policy that declares
 * `workingPrefixes` AND a non-empty title without one — an engine that never
 * decorates its title (copilot, custom wrappers) or a session that never set
 * a title answers `null`, never `"rest"`.
 */
export function titleTurnHint(policy: EngineTerminalTitlePolicy | undefined, title: string): "working" | "rest" | null {
  const working = policy?.workingPrefixes
  if (policy?.ownsStatus !== true || !working || working.length === 0) return null
  const trimmed = title.trim()
  if (trimmed.length === 0) return null
  return working.some((prefix) => trimmed.startsWith(prefix)) ? "working" : "rest"
}
