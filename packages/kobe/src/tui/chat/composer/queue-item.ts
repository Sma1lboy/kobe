/**
 * Composer queue entry — extracted from `ComposerQueue.tsx` so the type is
 * framework-free (issue #15 G3): the Solid and React queue panels, the shared
 * `ComposerProps`, and the chat panes all consume this one shape.
 */
export type ComposerQueuedItem =
  | { readonly id: string; readonly kind: "prompt"; readonly text: string }
  | { readonly id: string; readonly kind: "bash"; readonly command: string }
