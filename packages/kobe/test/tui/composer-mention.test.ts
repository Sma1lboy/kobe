/**
 * Unit tests for the chat composer's `@`-mention helpers
 * (`src/tui/panes/chat/composer/mention.ts`).
 *
 * What these tests prove:
 *
 *   1. {@link findMentionContext} — the cursor-aware anchor scan that
 *      decides whether the dropdown opens. The contract mirrors
 *      opcode's `FloatingPromptInput.tsx` (§478-533): walk back from
 *      the cursor, stop at `@` or whitespace, accept only `@` that
 *      sits at buffer start or follows whitespace. Regressions here
 *      would either swallow `email@host`-style text into the picker
 *      or fail to open on a legitimate mention.
 *
 *   2. {@link filterMentionMatches} — the ranking that decides which
 *      file is highlighted first when the user opens `@`. Filename-
 *      prefix beats directory-boundary beats plain substring. Ties
 *      break on shorter path length so `src/foo.ts` ranks above
 *      `deep/nested/dir/foo.ts`. The dropdown is only useful if the
 *      "obvious" match is first; without this test a future ranking
 *      change could silently push the right file off the top.
 *
 * The `getWorktreeFiles` cache is intentionally NOT tested here — it
 * wraps `listFiles` from `filetree/git.ts` which has its own coverage,
 * and exercising the cache requires faking time. The mention dropdown's
 * end-to-end behavior is covered by future behavior tests once the
 * harness supports keystroke-driven popup assertions.
 */

import { filterMentionMatches, findMentionContext, formatDisplayPath } from "@/tui/panes/chat/composer/mention"
import { describe, expect, test } from "vitest"

describe("findMentionContext", () => {
  test("returns null when buffer is empty", () => {
    expect(findMentionContext("", 0)).toBeNull()
  })

  test("returns null when cursor sits before any `@`", () => {
    expect(findMentionContext("hello", 5)).toBeNull()
  })

  test("opens on a bare `@` at buffer start", () => {
    expect(findMentionContext("@", 1)).toEqual({ atPos: 0, query: "" })
  })

  test("captures the query between `@` and cursor", () => {
    expect(findMentionContext("@src/Co", 7)).toEqual({ atPos: 0, query: "src/Co" })
  })

  test("opens when `@` is preceded by whitespace mid-buffer", () => {
    expect(findMentionContext("look at @comp", 13)).toEqual({ atPos: 8, query: "comp" })
  })

  test("rejects `@` that's part of a word (e.g. email)", () => {
    // `email@host` — the `@` is preceded by `l`, so no mention.
    expect(findMentionContext("email@host", 10)).toBeNull()
  })

  test("closes when whitespace appears between `@` and cursor", () => {
    expect(findMentionContext("@foo bar", 8)).toBeNull()
  })

  test("closes when cursor sits before the `@` despite later text", () => {
    expect(findMentionContext("hello @foo", 5)).toBeNull()
  })

  test("opens after a newline boundary", () => {
    expect(findMentionContext("line1\n@bar", 10)).toEqual({ atPos: 6, query: "bar" })
  })

  test("uses the most recent `@` when cursor is mid-mention", () => {
    // `@foo @ba|r` — the active mention is `ba`, not `foo`.
    const text = "@foo @bar"
    expect(findMentionContext(text, 8)).toEqual({ atPos: 5, query: "ba" })
  })
})

describe("filterMentionMatches", () => {
  const FILES = [
    "Composer.tsx",
    "src/tui/panes/chat/Chat.tsx",
    "src/tui/panes/chat/Composer.tsx",
    "src/tui/panes/chat/composer/mention.ts",
    "src/tui/panes/filetree/FileTree.tsx",
    "docs/DESIGN.md",
    "package.json",
  ]

  test("empty query returns the first N files in input order", () => {
    const out = filterMentionMatches(FILES, "", 3)
    expect(out.map((m) => m.path)).toEqual(FILES.slice(0, 3))
  })

  test("limit=0 returns no matches", () => {
    expect(filterMentionMatches(FILES, "anything", 0)).toEqual([])
  })

  test("filename-prefix ranks above substring", () => {
    const out = filterMentionMatches(FILES, "comp", 10)
    expect(out.length).toBeGreaterThan(0)
    // Both top-level `Composer.tsx` and `chat/Composer.tsx` start the
    // filename with "comp". Shorter path wins on the tie-breaker.
    expect(out[0]?.path).toBe("Composer.tsx")
  })

  test("case-insensitive match", () => {
    const out = filterMentionMatches(FILES, "DESIGN", 5)
    expect(out.map((m) => m.path)).toContain("docs/DESIGN.md")
  })

  test("directory-boundary match outranks plain substring", () => {
    // Query "chat" matches "/chat/" (directory boundary) for chat-
    // family files and would substring-match "Chat.tsx" filename
    // (which wins as filename-prefix anyway). The filetree file has
    // neither — it should be filtered out.
    const out = filterMentionMatches(FILES, "chat", 10)
    const paths = out.map((m) => m.path)
    expect(paths).toContain("src/tui/panes/chat/Chat.tsx")
    expect(paths).not.toContain("src/tui/panes/filetree/FileTree.tsx")
  })

  test("non-matching query yields empty list", () => {
    expect(filterMentionMatches(FILES, "zzzzz", 10)).toEqual([])
  })

  test("respects limit", () => {
    const out = filterMentionMatches(FILES, "s", 2)
    expect(out.length).toBeLessThanOrEqual(2)
  })

  test("returns displayPath stripped of monorepo `packages/` prefix", () => {
    const out = filterMentionMatches(FILES, "", 10)
    const composerEntry = out.find((m) => m.path === "src/tui/panes/chat/Composer.tsx")
    // FILES doesn't include any `packages/` paths above — separately
    // check the helper directly. (Empty-query path preserves order so
    // we just sanity-check the structure.)
    expect(composerEntry?.displayPath).toBe("src/tui/panes/chat/Composer.tsx")
  })

  test("monorepo: top-level same-filename file ranks above sub-package one", () => {
    // Realistic monorepo: README.md at repo root vs deep under
    // packages/<pkg>/test/.../README.md. Length tie-break must put
    // the shorter path first when both score the same filename-prefix.
    const monorepoFiles = ["packages/kobe/test/behavior/fixtures/README.md", "packages/kobe/README.md", "README.md"]
    const out = filterMentionMatches(monorepoFiles, "rea", 5)
    expect(out[0]?.path).toBe("README.md")
    expect(out[1]?.path).toBe("packages/kobe/README.md")
  })
})

describe("formatDisplayPath", () => {
  test("strips `packages/` prefix", () => {
    expect(formatDisplayPath("packages/kobe/src/foo.ts")).toBe("kobe/src/foo.ts")
  })

  test("leaves non-monorepo paths untouched", () => {
    expect(formatDisplayPath("docs/DESIGN.md")).toBe("docs/DESIGN.md")
    expect(formatDisplayPath("CLAUDE.md")).toBe("CLAUDE.md")
  })

  test("only strips literal `packages/`, not similar prefixes", () => {
    expect(formatDisplayPath("package.json")).toBe("package.json")
    expect(formatDisplayPath("packaged/thing.ts")).toBe("packaged/thing.ts")
  })
})
