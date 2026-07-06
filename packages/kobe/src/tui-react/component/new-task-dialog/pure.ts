/**
 * Framework-free helpers for the React new-task dialog (issue #15, G3W2).
 *
 * The bulk of the dialog's pure logic (field cycling, filters, windowing)
 * already lives in the shared `src/tui/component/new-task-dialog/state.ts`
 * and is consumed verbatim by both frameworks. This file holds only the
 * bits the Solid shell computes inline — extracted here so the React port
 * can unit-test them without mounting the dialog (`test/tui-react/
 * new-task-pure.test.ts`). No React, no Solid, no fs.
 */

import { ALL_VENDORS, type VendorId } from "@/types/vendor"

/**
 * Engine selector source: detected vendors only, falling back to the full
 * list when the caller passed nothing/empty — the selector is never empty
 * and task creation is never blocked.
 */
export function resolveVendorSet(available: readonly VendorId[] | undefined): readonly VendorId[] {
  return available && available.length > 0 ? available : ALL_VENDORS
}

/**
 * Initial engine selection: the user's last-selected vendor, clamped to a
 * detected one (first detected wins when the preference isn't available).
 */
export function resolveInitialVendor(set: readonly VendorId[], preferred: VendorId | undefined): VendorId {
  const pref = preferred ?? "claude"
  return set.includes(pref) ? pref : (set[0] ?? "claude")
}

/** Immutable toggle of one path in the adopt multi-select. */
export function toggleInSet(prev: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(prev)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

/**
 * Ctrl+A semantics on the Adopt tab: everything selected → clear;
 * otherwise select every visible path. Empty list returns `prev` unchanged.
 */
export function toggleSelectAll(prev: ReadonlySet<string>, paths: readonly string[]): ReadonlySet<string> {
  if (paths.length === 0) return prev
  const allSelected = paths.every((p) => prev.has(p))
  return allSelected ? new Set<string>() : new Set(paths)
}
