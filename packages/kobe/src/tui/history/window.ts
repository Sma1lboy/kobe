export const RENDER_WINDOW = 200

export interface TailWindow<T> {
  readonly hiddenCount: number
  readonly visible: readonly T[]
}

export function windowTail<T>(list: readonly T[], cap: number = RENDER_WINDOW): TailWindow<T> {
  if (list.length <= cap) return { hiddenCount: 0, visible: list }
  return { hiddenCount: list.length - cap, visible: list.slice(list.length - cap) }
}
