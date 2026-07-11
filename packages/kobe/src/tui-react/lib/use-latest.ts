/**
 * A ref that always holds the latest render's value — the shared spelling of
 * the render-phase `const xRef = useRef(x); xRef.current = x` idiom, used so
 * stable callbacks/effects can read current state without re-arming on every
 * change. Reading `.current` during render is still forbidden (same rule as
 * writing the idiom by hand).
 */

import { type MutableRefObject, useRef } from "react"

export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value)
  ref.current = value
  return ref
}
