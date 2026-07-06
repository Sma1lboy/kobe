/**
 * Directory drill-down derivation (issue #15, G3W2) — memoized
 * split + readdir + filter over a typed path, shared by the existing
 * tab's browse-mode repo picker and the clone tab's parent-dir picker.
 * Pure plumbing from `src/tui/lib/path-helpers.ts`.
 */

import { useMemo } from "react"
import { filterSubdirs, listSubdirs, splitPathForDirSuggest } from "../../../tui/lib/path-helpers"

export function useDerivedDir(value: string) {
  const split = useMemo(() => splitPathForDirSuggest(value), [value])
  const filtered = useMemo(() => filterSubdirs(listSubdirs(split.base), split.filter), [split])
  return { split, filtered }
}
