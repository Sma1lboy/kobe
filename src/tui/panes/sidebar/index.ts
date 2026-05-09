/**
 * Sidebar pane public surface.
 *
 * The orchestrator (Stream E) imports `Sidebar` from here and threads
 * Solid signals into it. This barrel is the contract — everything F
 * commits to expose to the rest of the codebase. Add new exports here,
 * not via deep paths.
 *
 * Note for tests: importing `Sidebar` (the JSX component) drags in
 * `@opentui/core`, which requires Bun's runtime. Vitest runs under
 * Node, so unit tests should import directly from `./groups` and
 * `./controller` — both are pure and runtime-agnostic.
 */

export {
  GG_CHORD_TIMEOUT_MS,
  type SidebarController,
  type SidebarControllerOpts,
  createSidebarController,
} from "./controller"
export { type SidebarRow, buildRows, flattenIds, groupByRepo, repoLabel } from "./groups"
export { useSidebarBindings } from "./keys"
export { Sidebar, type SidebarProps } from "./Sidebar"
