/**
 * Shareable links into the dashboard. A task's deep link is the route a
 * teammate (or you, later) can paste to land straight on that task. Pure so the
 * URL shape is unit-testable; the component passes window.location.origin.
 */

/** `<origin>/task/<taskId>` — the deep link the `/task/$taskId` route handles.
 *  A trailing slash on the origin is normalized so we never emit `//task`. */
export function taskDeepLink(origin: string, taskId: string): string {
  return `${origin.replace(/\/+$/, "")}/task/${encodeURIComponent(taskId)}`
}
