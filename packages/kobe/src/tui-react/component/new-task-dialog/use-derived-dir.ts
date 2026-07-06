import { useMemo } from "react"
import { filterSubdirs, listSubdirs, splitPathForDirSuggest } from "../../../tui/lib/path-helpers"

export function useDerivedDir(value: string) {
  const split = useMemo(() => splitPathForDirSuggest(value), [value])
  const filtered = useMemo(() => filterSubdirs(listSubdirs(split.base), split.filter), [split])
  return { split, filtered }
}
