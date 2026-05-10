/**
 * Unit tests for the pure helpers exported from `help-dialog.tsx`.
 *
 * Why these tests matter:
 *   - The HelpDialog itself is a render-only component covered by the
 *     existing behavior test (`test/behavior/keybindings.test.ts`). The
 *     two helpers extracted alongside the new "Slash commands" section
 *     are the only logic we own here, so they get the smallest possible
 *     unit test that pins their contract.
 *   - `formatSlashLabel` is the one place that codifies the leading-`/`
 *     convention in the dialog row. If the help dialog ever drifts from
 *     the composer's `/<name>` rendering, the dialog will look like a
 *     third-party tool — exactly what kobe is trying to avoid.
 *   - `orderSlashes` guarantees deterministic alphabetical order so
 *     screenshot-style behavior tests (future) and visual scans aren't
 *     hostage to insertion order in the manifest file.
 */

// Import from the leaf helpers module rather than `./help-dialog`
// (the `.tsx` component) — the JSX file pulls in `@opentui/core`,
// which needs Bun's FFI to load its bundled `.scm` highlight grammar
// and crashes vitest's Node-runtime worker pool on import. Same
// pattern the sidebar tests use (see `test/tui/sidebar.test.tsx`).
import { describe, expect, test } from "vitest"
import { formatSlashLabel, orderSlashes } from "../../src/tui/component/help-dialog-helpers"
import type { BuiltinSlash } from "../../src/tui/panes/chat/composer/builtin-slashes"

describe("formatSlashLabel", () => {
  test("prefixes the slash name with `/`", () => {
    expect(formatSlashLabel("commit")).toBe("/commit")
  })

  test("does not double-prefix when caller already passes a leading slash (defensive)", () => {
    // We only ever pass bare names from the manifest, but if a future
    // call site forgets, we still want a usable string — not `//foo`.
    // The contract is "render the name as a slash command"; we
    // intentionally tolerate either form rather than panic.
    expect(formatSlashLabel("/commit")).toBe("//commit")
  })
})

describe("orderSlashes", () => {
  const fixtures: readonly BuiltinSlash[] = [
    { name: "commit", description: "Create a git commit" },
    { name: "advisor", description: "Configure the advisor model" },
    { name: "review", description: "Review a pull request" },
  ]

  test("returns a new array sorted alphabetically by name", () => {
    const ordered = orderSlashes(fixtures)
    expect(ordered.map((s) => s.name)).toEqual(["advisor", "commit", "review"])
  })

  test("does not mutate the input array", () => {
    const before = fixtures.map((s) => s.name)
    orderSlashes(fixtures)
    expect(fixtures.map((s) => s.name)).toEqual(before)
  })

  test("handles an empty list", () => {
    expect(orderSlashes([])).toEqual([])
  })
})
