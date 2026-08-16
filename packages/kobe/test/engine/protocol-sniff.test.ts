/**
 * Tier (b) of protocol resolution — naming the engine behind a session whose
 * launch command tier (a) could not name (issue #30).
 *
 * The rule under test is conservatism: evidence identifies, absence of
 * evidence answers null, and AMBIGUOUS evidence also answers null. A wrong
 * protocol is worse than no protocol — it points the history reader and the
 * trust store at another vendor's files — so a glyph two vendors both write
 * must identify neither. Today's built-in vocabularies happen to be disjoint
 * (pinned below), which is what lets a title identify anything at all.
 */

import { describe, expect, it } from "vitest"
import { sniffProtocolFromSessions, sniffProtocolFromTitle } from "../../src/engine/protocol-sniff.ts"
import { engineEntry } from "../../src/engine/registry.ts"
import { BUILTIN_VENDORS } from "../../src/types/vendor.ts"

describe("sniffProtocolFromTitle", () => {
  it("names the vendor whose status glyph is UNIQUE to it", () => {
    // claude's resting ✳ belongs to no other built-in.
    expect(sniffProtocolFromTitle("✳ refactoring the parser")).toBe("claude")
  })

  it("names codex from a spinner frame only codex declares", () => {
    expect(sniffProtocolFromTitle("⠹ fixing the build")).toBe("codex")
  })

  it("keeps the built-in vocabularies disjoint — the property the sniff rests on", () => {
    // Every glyph today belongs to exactly one engine, which is WHY a title
    // can identify one. The sniff returns null for a shared glyph rather than
    // picking a winner, so a future engine that borrows ✳ or a braille frame
    // degrades this test to a null answer instead of a silent misattribution
    // — but it should fail HERE first, where the cause is visible.
    const owners = new Map<string, string[]>()
    for (const vendor of BUILTIN_VENDORS) {
      for (const glyph of engineEntry(vendor).terminalTitle?.statusPrefixes ?? []) {
        owners.set(glyph, [...(owners.get(glyph) ?? []), vendor])
      }
    }
    const shared = [...owners.entries()].filter(([, vendors]) => vendors.length > 1)
    expect(shared).toEqual([])
  })

  it("stays silent on an undecorated title", () => {
    expect(sniffProtocolFromTitle("bash")).toBeNull()
    expect(sniffProtocolFromTitle("")).toBeNull()
    expect(sniffProtocolFromTitle(null)).toBeNull()
    expect(sniffProtocolFromTitle(undefined)).toBeNull()
  })

  it("treats a title that is ONLY the glyph as a name, not a status", () => {
    // Same conservatism as `stripEngineStatusPrefix`: a session genuinely
    // named "✳" is a name; there is no title left to be decorating.
    expect(sniffProtocolFromTitle("✳")).toBeNull()
  })
})

describe("sniffProtocolFromSessions", () => {
  it("stays silent without a worktree to look under", async () => {
    expect(await sniffProtocolFromSessions(undefined)).toBeNull()
    expect(await sniffProtocolFromSessions("")).toBeNull()
  })

  it("stays silent for a directory no engine has ever written a session for", async () => {
    // Readers are best-effort by contract, so a nonexistent path resolves to
    // "no store answered" rather than throwing.
    expect(await sniffProtocolFromSessions("/nonexistent/worktree-that-no-engine-touched")).toBeNull()
  })
})
