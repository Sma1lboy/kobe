/**
 * File tree pane public surface.
 *
 * The orchestrator (Wave 3 integration agent) imports `FileTree` from
 * here and threads Solid signals into it. This barrel is the contract —
 * everything Stream H exposes to the rest of the codebase. Add new
 * exports here, not via deep paths.
 *
 * Note for tests: importing `FileTree` (the JSX component) drags in
 * `@opentui/core`, which requires Bun's runtime. Vitest runs under
 * Node, so unit tests should import directly from `./git` for parser
 * coverage. The pane's full visual flow is exercised by the behavior
 * test (`test/behavior/filetree.test.ts`) which spawns kobe in a
 * PTY against a real fixture worktree.
 */

export { FILETREE_WIDTH, FileTree, type FileTreeProps } from "./FileTree"
export {
  type FileStatus,
  type StatusEntry,
  gitWrapper,
  listFiles,
  parsePorcelain,
  statusFiles,
} from "./git"
export { type FileTreeTab, TAB_FOR_KEY, useFileTreeBindings } from "./keys"
