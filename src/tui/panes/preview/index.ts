/**
 * Preview pane public surface.
 *
 * Mirrors the sidebar barrel pattern (`panes/sidebar/index.ts`):
 *   - Re-export the JSX component + its `PreviewProps` and `PreviewApi` so
 *     the parent (Stream H file tree → orchestrator) imports from this
 *     barrel.
 *   - Re-export the pure helpers (`state.ts`, `diff.ts`) so unit tests can
 *     pull them without dragging `@opentui/solid` into Node's module
 *     graph (the JSX component requires Bun's runtime).
 *
 * Add new exports here, not via deep paths — the barrel is the contract.
 */

export {
  EMPTY_STATE,
  type PreviewMode,
  type PreviewState,
  type PreviewTab,
  activeTab,
  closeTab,
  findTabIndex,
  moveActive,
  openTab,
  setActiveMode,
  setActiveScroll,
  tabLabel,
} from "./state"

export { type ReadResult, isPathChanged, readDiff, readFile, splitLines } from "./diff"

export { Preview, type PreviewApi, type PreviewProps } from "./Preview"
