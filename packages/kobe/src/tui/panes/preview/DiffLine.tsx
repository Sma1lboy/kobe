/**
 * Diff-line renderer for the preview pane.
 *
 * Ported verbatim from `src/tui/component/dialog-diff.tsx`'s `DiffLine`
 * (which itself was lifted from the user's opencode fork at
 * `refs/opencode/.../component/dialog-diff.tsx`). The colorization table
 * is identical so the preview pane visually matches the `/diff` dialog —
 * users see the same `+` green / `-` red / `@@` hunk-header colors no
 * matter which surface they entered through.
 *
 * Why we don't import the original `DiffLine` directly:
 *   1. The brief tells us not to touch `dialog-diff.tsx` (Stream 0.2
 *      slice). Importing is allowed but the brief says copying with an
 *      attribution comment is the more durable option — when Wave 4
 *      polish swaps in syntax highlighting, the preview pane evolves
 *      independently of the lifted dialog.
 *   2. Keeping a copy here means the dialog can be deleted/restructured
 *      in a future stream without breaking the preview's render path.
 *
 * Attribution: see `src/tui/component/dialog-diff.tsx` for the original
 * (and its own attribution to `refs/opencode`). Any change to colorization
 * heuristics should be mirrored across both files until the dialog is
 * refactored to consume this component.
 */

import type { RGBA } from "@opentui/core"
import { useTheme } from "../../context/theme"

/**
 * Render a single line of a unified diff. The line is classified by its
 * leading byte:
 *   - `@@`            → hunk header (uses `theme.diffHunkHeader`)
 *   - `+++` / `---`   → file headers (muted)
 *   - `diff `/`index `→ file metadata (muted)
 *   - `+`             → addition (green fg, green-tinted bg)
 *   - `-`             → deletion (red fg, red-tinted bg)
 *   - everything else → context line (default text color)
 *
 * The empty-line fallback (`text || " "`) is important: opentui's `text`
 * collapses empty children, which would visually merge two adjacent
 * blank diff lines into one. The space character forces a row.
 */
export function DiffLine(props: { text: string }) {
  const { theme } = useTheme()
  const text = props.text
  const styled = (() => {
    if (text.startsWith("@@")) return { fg: theme.diffHunkHeader, bg: undefined as RGBA | undefined }
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index "))
      return { fg: theme.textMuted, bg: undefined as RGBA | undefined }
    if (text.startsWith("+")) return { fg: theme.diffAdded, bg: theme.diffAddedBg }
    if (text.startsWith("-")) return { fg: theme.diffRemoved, bg: theme.diffRemovedBg }
    return { fg: theme.text, bg: undefined as RGBA | undefined }
  })()
  return (
    <box backgroundColor={styled.bg} paddingLeft={1} paddingRight={1}>
      <text fg={styled.fg} wrapMode="none">
        {text || " "}
      </text>
    </box>
  )
}

/**
 * Render a plain (non-diff) line of file content. Same row shell as
 * `DiffLine` so File and Diff modes line up vertically when toggled.
 */
export function FileLine(props: { text: string }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={1} paddingRight={1}>
      <text fg={theme.text} wrapMode="word">
        {props.text || " "}
      </text>
    </box>
  )
}
