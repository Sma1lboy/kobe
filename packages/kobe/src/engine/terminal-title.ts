/**
 * Terminal-title policy — the rules for reading an engine's OWN OSC 0/2
 * title, split out of `registry.ts` (the ~500-line cap).
 *
 * Pure on purpose: every function here takes the engine's declared
 * {@link EngineTerminalTitle} rather than a vendor id, so `registry.ts` keeps
 * the one vendor→entry resolution (and its thin wrappers stay the import
 * site every neutral caller already uses) while the rules live here. Nothing
 * in this file names an engine — the vendor-specific KNOWLEDGE (which
 * glyphs, which identifier shape) is declared by the adapter that owns it.
 *
 * Three questions a neutral surface asks of a live title, in order:
 *   1. what is the NAME in it — {@link stripStatusPrefix} drops the engine's
 *      own status decoration, which kobe draws in its own glyph column;
 *   2. what does it say about the TURN — {@link titleTurnHint};
 *   3. is it a name at ALL — {@link titleIsPlaceholder} / {@link titleSessionId}.
 *
 * Question 3 exists because an engine's title is only as good as what the
 * engine has to put in it. Codex writes its thread UUID until the thread is
 * named, so a fresh codex tab reported `01a00ee9-f0e9-…` where claude and
 * kimi report a sentence. Two knobs answer that, because two different
 * things can be wrong with a title and a future engine may need either: the
 * placeholder carries a session id kobe can name the tab FROM
 * ({@link EngineTerminalTitle.sessionIdFromTitle}), or it carries nothing at
 * all ({@link EngineTerminalTitle.isPlaceholderTitle}).
 */

/**
 * Native OSC 0/2 title policy for an engine's interactive sessions.
 * `ownsStatus` means the engine's live title is the status surface while it
 * is visible, so neutral tab chrome must not prefix a duplicate turn glyph.
 * `launchArgs` lets an adapter select the engine's own title fields without
 * teaching the launcher vendor-specific config syntax — the FIRST way to fix
 * a bad title is to ask the engine for a better one.
 */
export interface EngineTerminalTitle {
  readonly ownsStatus: boolean
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
   * {@link titleTurnHint}. Omit when the engine's resting title is
   * indistinguishable from its working one.
   */
  readonly workingPrefixes?: readonly string[]
  /**
   * The engine's SESSION id read back out of its own title, for engines
   * whose title IS an identifier until they have a name for it. Codex's
   * `thread-title` segment documents itself as "the thread title, or the
   * thread identifier when unnamed", so a fresh codex tab's OSC title is a
   * bare UUID.
   *
   * A non-null answer means BOTH things kobe needs. The title must not be
   * RENDERED as a name — a UUID beside a task is noise where claude and
   * kimi put a sentence. And the session it points at is exactly what names
   * the tab instead: the engine's own `history` reader turns that id into
   * the conversation's first-prompt summary, which is the label the user
   * actually wanted.
   *
   * Resolution is deliberately STRICT — only the engine that declared the
   * rule may answer, never the guess-the-vendor union
   * {@link titleIsPlaceholder} falls back on: the id is about to be looked
   * up in THAT vendor's transcript store, and reading it from the wrong one
   * is worse than having no name.
   *
   * Absent = this engine's title is always a name (claude, kimi).
   */
  readonly sessionIdFromTitle?: (title: string) => string | null
  /**
   * The other shape of "this is not a name": a placeholder carrying no
   * session id either — an engine that writes its cwd, its model, or a
   * literal "shell" until it has something better to say. Kobe drops such a
   * title and names the tab from what it already knows (the first-prompt
   * summary, then the vendor default).
   *
   * Engines whose placeholder IS an id declare {@link sessionIdFromTitle}
   * instead — that already implies this one. This knob is for the ones where
   * it isn't, so a future engine's bad title never becomes a vendor check in
   * neutral code.
   */
  readonly isPlaceholderTitle?: (title: string) => boolean
}

/**
 * Strip an engine's leading STATUS decoration from a live OSC title.
 *
 * Conservative where it matters: a prefix that would consume the whole title
 * is returned unchanged, so a session genuinely named after one of these
 * glyphs keeps its name. Longest-first so a multi-char prefix isn't shadowed
 * by a shorter one. See {@link EngineTerminalTitle.statusPrefixes}; the
 * vendor→vocabulary resolution (including the union fallback for a title
 * whose engine isn't known yet) lives in `registry.ts`.
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
 * What the engine's live OSC title says about its turn state, or `null` when
 * the title carries no verdict.
 *
 * A status-owning engine writes its animated frames (`workingPrefixes`) into
 * the title exactly while a turn runs and rewrites the title the moment it
 * stops — including on an ESC interrupt, which fires no Stop hook at all
 * (claude-code's abort path returns before its stop hooks; issue #15). That
 * rewrite is therefore the one event-grade "the turn ended" signal an
 * interrupt produces.
 *
 * Strict on purpose: `"rest"` is only claimed for an engine that declares
 * `workingPrefixes` AND wrote a non-empty title without one — an engine that
 * never decorates its title (copilot, custom wrappers) or a session that
 * never set a title answers `null`, never `"rest"`.
 */
export function titleTurnHint(config: EngineTerminalTitle | undefined, title: string): "working" | "rest" | null {
  const working = config?.workingPrefixes
  if (config?.ownsStatus !== true || !working || working.length === 0) return null
  const trimmed = title.trim()
  if (trimmed.length === 0) return null
  return working.some((prefix) => trimmed.startsWith(prefix)) ? "working" : "rest"
}

/**
 * The engine session id this title IS, or null when the title is a name (or
 * the engine declares no such rule). See
 * {@link EngineTerminalTitle.sessionIdFromTitle}.
 */
export function titleSessionId(config: EngineTerminalTitle | undefined, title: string): string | null {
  const trimmed = title.trim()
  if (!trimmed) return null
  return config?.sessionIdFromTitle?.(trimmed) ?? null
}

/**
 * True when this title is not a NAME under the given policy — either an
 * explicit placeholder or an identifier the engine writes until its session
 * is named. Callers render something else instead (the first-prompt summary,
 * then the vendor default); they never show the placeholder itself.
 */
export function titleIsPlaceholder(config: EngineTerminalTitle | undefined, title: string): boolean {
  const trimmed = title.trim()
  if (!trimmed) return false
  return config?.isPlaceholderTitle?.(trimmed) === true || titleSessionId(config, trimmed) !== null
}
