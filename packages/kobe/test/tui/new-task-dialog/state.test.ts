/**
 * Unit tests for new-task-dialog pure helpers (`src/tui/component/
 * new-task-dialog/state.ts`).
 *
 * Why these matter: state.ts is the dialog's reducer layer — it must
 * stay pure (no Solid, no fs, no subprocess; the render-path sync guard
 * counts on that) so every behavior here is pinnable without standing
 * up opentui. Focus areas:
 *   - the picker mode logic the first-run flow leans on (KOB-250):
 *     with no saved repos the dialog defaults to the cwd — saved mode
 *     preselects it, and typing a `/` flips the picker into browse mode.
 *   - `computeRepoOptions` always surfaces the cwd even with no saved
 *     repos, so the first-run picker is never empty.
 *   - field cycling (`nextField` / `firstFieldFor`) per sub-tab — a
 *     wrong cycle strands keyboard users with no path to the Create
 *     button.
 *   - picker windowing/clamping (`windowAround` / `clampCursor`) — the
 *     80-branch-repo case must scroll, not push the dialog off-screen.
 *   - `resolveBaseRef` — highlighted branch wins over typed text;
 *     free text only kicks in when the filter matched nothing.
 */

import {
  clampCursor,
  computeRepoOptions,
  filterAdoptableByGlob,
  filterBranches,
  filterRepos,
  firstFieldFor,
  isBlankText,
  nextDialogTab,
  nextField,
  pickerModeFor,
  prevDialogTab,
  resolveBaseRef,
  stripNewlines,
  windowAround,
} from "@/tui/component/new-task-dialog/state"
import { describe, expect, it } from "vitest"

describe("filterAdoptableByGlob (KOB-256)", () => {
  const list = [
    { path: "/work/repo/.claude/worktrees/panda" },
    { path: "/work/feature-login" },
    { path: "/work/feature-signup" },
    { path: "/elsewhere/bugfix" },
  ]
  it("returns the full list for an empty glob", () => {
    expect(filterAdoptableByGlob(list, "")).toHaveLength(4)
    expect(filterAdoptableByGlob(list, "  ")).toHaveLength(4)
  })
  it("matches on basename so a bare pattern works", () => {
    expect(filterAdoptableByGlob(list, "feature-*").map((w) => w.path)).toEqual([
      "/work/feature-login",
      "/work/feature-signup",
    ])
  })
  it("matches on absolute path globs", () => {
    expect(filterAdoptableByGlob(list, "/work/**").map((w) => w.path)).toEqual([
      "/work/repo/.claude/worktrees/panda",
      "/work/feature-login",
      "/work/feature-signup",
    ])
  })
})

describe("nextDialogTab (KOB-256: 3-tab cycle)", () => {
  it("cycles existing → clone → adopt → existing", () => {
    expect(nextDialogTab("existing")).toBe("clone")
    expect(nextDialogTab("clone")).toBe("adopt")
    expect(nextDialogTab("adopt")).toBe("existing")
  })
})

describe("prevDialogTab (←/→ reverse cycle on the mode-tab selector)", () => {
  it("cycles existing → adopt → clone → existing", () => {
    expect(prevDialogTab("existing")).toBe("adopt")
    expect(prevDialogTab("adopt")).toBe("clone")
    expect(prevDialogTab("clone")).toBe("existing")
  })
})

describe("pickerModeFor", () => {
  it("stays in saved mode when the input exactly matches a saved repo", () => {
    const cwd = "/home/me/proj"
    expect(pickerModeFor(cwd, [cwd])).toBe("saved")
  })

  it("flips to browse mode once the input looks like a path", () => {
    expect(pickerModeFor("/home/me/proj/", ["/home/me/proj"])).toBe("browse")
    expect(pickerModeFor("~/code", [])).toBe("browse")
  })

  it("treats a short non-path query as saved (substring filter)", () => {
    expect(pickerModeFor("proj", ["/home/me/proj"])).toBe("saved")
  })
})

describe("computeRepoOptions", () => {
  it("surfaces the cwd even with no saved repos (first-run picker is never empty)", () => {
    const cwd = "/home/me/proj"
    expect(computeRepoOptions(cwd, [])).toEqual([cwd])
  })

  it("dedupes the cwd against the saved list and keeps it first", () => {
    const cwd = "/home/me/proj"
    expect(computeRepoOptions(cwd, [cwd, "/home/me/other"])).toEqual([cwd, "/home/me/other"])
  })
})

describe("nextField / firstFieldFor (per-tab field cycling)", () => {
  it("cycles the existing tab: tabs → engine → repo → baseRef → confirm → tabs", () => {
    expect(nextField("repo", "existing")).toBe("baseRef")
    expect(nextField("baseRef", "existing")).toBe("confirm")
    expect(nextField("confirm", "existing")).toBe("tabs")
    expect(nextField("tabs", "existing")).toBe("engine")
    expect(nextField("engine", "existing")).toBe("repo")
  })

  it("cycles the clone tab through the selectors + all four inputs to confirm and back", () => {
    expect(nextField("engine", "clone")).toBe("cloneUrl")
    expect(nextField("cloneUrl", "clone")).toBe("cloneParent")
    expect(nextField("cloneParent", "clone")).toBe("cloneFolder")
    expect(nextField("cloneFolder", "clone")).toBe("cloneBaseRef")
    expect(nextField("cloneBaseRef", "clone")).toBe("confirm")
    expect(nextField("confirm", "clone")).toBe("tabs")
  })

  it("walks the adopt tab tabs → engine → filter → confirm → tabs", () => {
    expect(nextField("engine", "adopt")).toBe("adoptFilter")
    expect(nextField("adoptFilter", "adopt")).toBe("confirm")
    expect(nextField("confirm", "adopt")).toBe("tabs")
  })

  it("threads the shared selectors + Create through every tab in the same order", () => {
    // confirm → tabs → engine → <first input> is shared trailer logic.
    expect(nextField("confirm", "existing")).toBe("tabs")
    expect(nextField("tabs", "clone")).toBe("engine")
    expect(nextField("engine", "adopt")).toBe("adoptFilter")
  })

  it("recovers a stale cross-tab field by restarting the cycle", () => {
    // e.g. field left on a clone field while existing tab is active.
    expect(nextField("cloneUrl", "existing")).toBe("repo")
    expect(nextField("repo", "clone")).toBe("cloneUrl")
  })

  it("knows each tab's first field for tab switches", () => {
    expect(firstFieldFor("existing")).toBe("repo")
    expect(firstFieldFor("clone")).toBe("cloneUrl")
    expect(firstFieldFor("adopt")).toBe("adoptFilter")
  })
})

describe("windowAround / clampCursor (picker windowing)", () => {
  const list = Array.from({ length: 20 }, (_, i) => `branch-${i}`)

  it("returns the whole list when it fits the cap", () => {
    const w = windowAround(list.slice(0, 5), 2, 8)
    expect(w).toEqual({ items: list.slice(0, 5), start: 0, total: 5 })
  })

  it("keeps the cursor in view by scrolling the window", () => {
    const w = windowAround(list, 10, 8)
    expect(w.start).toBe(6) // cursor - floor(cap/2)
    expect(w.items).toHaveLength(8)
    expect(w.items[10 - w.start]).toBe("branch-10")
    expect(w.total).toBe(20)
  })

  it("pins the window to the end when the cursor is near the tail", () => {
    const w = windowAround(list, 19, 8)
    expect(w.start).toBe(12)
    expect(w.items[w.items.length - 1]).toBe("branch-19")
  })

  it("clamps the cursor into [0, len-1] and returns 0 for empty lists", () => {
    expect(clampCursor(-3, 5)).toBe(0)
    expect(clampCursor(99, 5)).toBe(4)
    expect(clampCursor(2, 5)).toBe(2)
    expect(clampCursor(2, 0)).toBe(0)
  })
})

describe("filterRepos / filterBranches (substring filters)", () => {
  it("returns everything for an empty/whitespace query", () => {
    expect(filterRepos(["/a", "/b"], "  ")).toEqual(["/a", "/b"])
    expect(filterBranches(["main", "dev"], "")).toEqual(["main", "dev"])
  })

  it("matches case-insensitive substrings", () => {
    expect(filterRepos(["/Users/me/Kobe", "/tmp/other"], "kobe")).toEqual(["/Users/me/Kobe"])
    expect(filterBranches(["main", "feature/Login", "fix"], "login")).toEqual(["feature/Login"])
  })
})

describe("resolveBaseRef (picker highlight vs typed text)", () => {
  it("prefers the highlighted branch over the typed text", () => {
    expect(resolveBaseRef("ma", ["main", "master"], 1)).toBe("master")
  })

  it("falls back to the trimmed typed text when nothing is highlighted", () => {
    expect(resolveBaseRef("  v1.2.3  ", [], 0)).toBe("v1.2.3")
  })

  it("falls back to the default base ref when typed text is empty too", () => {
    expect(resolveBaseRef("   ", [], 0)).toBe("main")
  })
})

// The set-branch dialog (component/branch-picker-dialog.tsx) chains these
// two helpers exactly as the new-task baseRef picker does: filter the repo's
// local branches by the typed text, then resolve on Enter. These cases pin
// the re-branch contract — a brand-new name renames verbatim; a typed exact
// existing name keeps it; arrowing picks the highlighted row.
describe("filterBranches → resolveBaseRef (set-branch dialog composition)", () => {
  const branches = ["main", "master", "feature/login"]
  const resolveTyped = (typed: string, cursor = 0): string => {
    const filtered = filterBranches(branches, typed)
    return resolveBaseRef(typed, filtered, cursor)
  }

  it("passes a brand-new name through verbatim (no branch matches it)", () => {
    // "release-2" matches nothing → filtered is empty → typed text renames.
    expect(resolveTyped("release-2")).toBe("release-2")
  })

  it("keeps a typed exact existing name", () => {
    // "main" filters to ["main"] and the exact-match rule returns it verbatim.
    expect(resolveTyped("main")).toBe("main")
  })

  it("resolves to the highlighted row when the typed text only substring-matches", () => {
    const filtered = filterBranches(branches, "feat") // ["feature/login"]
    expect(resolveBaseRef("feat", filtered, 0)).toBe("feature/login")
  })
})

describe("stripNewlines (opentui input sanitizer)", () => {
  it("strips CR and LF anywhere in the value", () => {
    expect(stripNewlines("foo\n")).toBe("foo")
    expect(stripNewlines("foo\r\nbar\n")).toBe("foobar")
    expect(stripNewlines("clean")).toBe("clean")
  })
})

describe("isBlankText (empty required-field guard)", () => {
  it("treats no-non-whitespace strings as blank, including CJK whitespace", () => {
    // The bug this guards: a prompt/title of only a full-width space `　`
    // (U+3000) — emitted constantly by Chinese IMEs — must NOT pass the
    // submit guard. `.trim()` does not strip U+3000, so `!value.trim()`
    // wrongly accepted it; `isBlankText` (via `\S`) correctly rejects it.
    expect(isBlankText("")).toBe(true)
    expect(isBlankText(" ")).toBe(true)
    expect(isBlankText("\t  \n")).toBe(true)
    expect(isBlankText("　")).toBe(true) // U+3000 full-width / ideographic space
    expect(isBlankText("　　")).toBe(true)
    expect(isBlankText("　\t")).toBe(true) // full-width space + ASCII tab
    expect(isBlankText(" ")).toBe(true) // no-break space
  })

  it("treats any non-whitespace content as non-blank", () => {
    expect(isBlankText("hi")).toBe(false)
    expect(isBlankText(" 中文 ")).toBe(false) // CJK content with ASCII padding
    expect(isBlankText("　中文　")).toBe(false) // CJK content padded with full-width spaces
    expect(isBlankText(".")).toBe(false)
  })
})
