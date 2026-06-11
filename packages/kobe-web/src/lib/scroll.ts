/**
 * Is a scroll container within `threshold` px of its bottom? Drives the
 * transcript's stick-to-bottom (auto-follow while streaming) and the
 * jump-to-latest affordance (shown when scrolled up). Pure so the threshold
 * math is unit-testable away from the DOM.
 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 80,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold
}
