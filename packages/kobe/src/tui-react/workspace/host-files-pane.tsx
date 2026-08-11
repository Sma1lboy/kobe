/** @jsxImportSource @opentui/react */
/**
 * The workspace host's right rail — the FileTree pane and its width math.
 *
 * Extracted from `host.tsx` when it crossed the file-size cap (same reason
 * as `host-sidebar.tsx`). Width: a third of what's left beside the sidebar,
 * clamped to the documented worktree-tools convention [22, 34].
 */

import { useTerminalDimensions } from "@opentui/react"
import { SIDEBAR_WIDTH } from "../../tui/panes/sidebar/view-core"
import { useFocus } from "../context/focus"
import { useTheme } from "../context/theme"
import { FileTree } from "../panes/filetree/FileTree"

const WORKTREE_TOOLS_MIN_WIDTH = 22
const WORKTREE_TOOLS_MAX_WIDTH = 34

export function HostFilesPane(props: {
  readonly worktree: string | null
  readonly prBaseRef: string | undefined
  /** Dialog-gated pane focus (`activePane`), not the raw focus context. */
  readonly focused: boolean
  readonly onOpenFile: (relPath: string) => void
  readonly onOpenDiff: (relPath: string, base?: string) => void
  readonly onZenToggle: () => void
  readonly onCreatePR: () => void
}) {
  const { theme, transparentBackground } = useTheme()
  const focus = useFocus()
  const dims = useTerminalDimensions()
  const inactiveBorder = transparentBackground ? theme.border : theme.borderSubtle
  const available = Math.max(WORKTREE_TOOLS_MIN_WIDTH, dims.width - SIDEBAR_WIDTH)
  const width = Math.max(WORKTREE_TOOLS_MIN_WIDTH, Math.min(WORKTREE_TOOLS_MAX_WIDTH, Math.floor(available / 3)))
  return (
    <box
      width={width}
      flexShrink={0}
      borderColor={focus.focused === "files" ? theme.focusAccent : inactiveBorder}
      onMouseUp={() => focus.setFocused("files")}
    >
      <FileTree
        worktreePath={props.worktree}
        paneWidth={width - 2 /* box border */}
        prBaseRef={props.prBaseRef}
        focused={props.focused}
        onOpenFile={props.onOpenFile}
        onOpenDiff={props.onOpenDiff}
        onZenToggle={props.onZenToggle}
        onCreatePR={props.onCreatePR}
      />
    </box>
  )
}
