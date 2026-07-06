---
"@sma1lboy/kobe": patch
---

React port of the file tree pane (issue #15, G3): `src/tui-react/panes/filetree/` mirrors the Solid pane on the shared framework-free logic (`git.ts`, `rows.ts`, and the newly extracted `pane-core.ts` / `keys-core.ts`), with a `dev:mock-react-filetree` render proof against a throwaway git fixture. The Solid `FileTree.tsx` was also split back under the 500-line cap (pane-core / keys-core / row-view / header-view), behavior-preserving.
