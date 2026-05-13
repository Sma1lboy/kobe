export type DropdownWindow<T> = {
  readonly items: readonly T[]
  readonly start: number
  readonly total: number
}

export function makeDropdownWindow<T>(items: readonly T[], cursor: number, maxVisible: number): DropdownWindow<T> {
  const total = items.length
  if (total <= maxVisible) return { items, start: 0, total }
  const half = Math.floor(maxVisible / 2)
  let start = Math.max(0, cursor - half)
  if (start + maxVisible > total) start = total - maxVisible
  return { items: items.slice(start, start + maxVisible), start, total }
}
