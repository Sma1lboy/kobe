/**
 * Pure helpers used by `help-dialog.tsx`. Split out so vitest (Node
 * runtime) can unit-test them without importing `@opentui/core`, which
 * needs Bun's FFI to load the bundled `.scm` highlight grammar.
 *
 * Same pattern the sidebar uses (`groups.ts` next to `Sidebar.tsx`):
 * the JSX component owns rendering, this module owns logic, the tests
 * import from here.
 */

import type { BuiltinSlash } from "../panes/chat/composer/builtin-slashes"

/**
 * Render a slash command name as the canonical `/<name>` label. Pulled
 * out so the rendering layer doesn't repeat the leading-slash convention
 * inline, and so tests can pin the exact label format.
 */
export function formatSlashLabel(name: string): string {
  return `/${name}`
}

/**
 * Sort the slash list deterministically (alphabetical by name). We don't
 * group by category — the bundled manifest is a flat list of ~16 entries
 * and a single-section render is the cleanest match. Returns a NEW array
 * so callers (and the manifest) keep their original ordering intact.
 */
export function orderSlashes(slashes: readonly BuiltinSlash[]): readonly BuiltinSlash[] {
  return [...slashes].sort((a, b) => a.name.localeCompare(b.name))
}
