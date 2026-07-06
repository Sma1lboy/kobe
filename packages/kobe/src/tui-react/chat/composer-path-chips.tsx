/** @jsxImportSource @opentui/react */
/**
 * React clickable path chips above the composer input — the
 * `src/tui/chat/ComposerPathChips.tsx` counterpart (issue #15 G3).
 * Label truncation is the shared framework-free `composer/path-preview`.
 */

import { TextAttributes } from "@opentui/core"
import { formatPreviewPathLabel } from "../../tui/chat/composer/path-preview"
import { useTheme } from "../context/theme"

export interface ComposerPathRef {
  readonly path: string
}

export interface ComposerPathChipsProps {
  readonly hasTask: boolean
  readonly refs: readonly ComposerPathRef[]
  readonly onOpenFilePath?: (relPath: string) => void
}

export function ComposerPathChips(props: ComposerPathChipsProps) {
  const { theme } = useTheme()
  if (!props.hasTask || props.refs.length === 0) return null
  return (
    <box flexDirection="row" gap={1} alignItems="center" paddingBottom={1}>
      <text fg={theme.textMuted} wrapMode="none">
        open
      </text>
      {props.refs.map((ref) => (
        <box
          key={ref.path}
          flexDirection="row"
          flexShrink={1}
          maxWidth={36}
          backgroundColor={theme.backgroundPanel}
          paddingLeft={1}
          paddingRight={1}
          onMouseUp={() => props.onOpenFilePath?.(ref.path)}
        >
          <text fg={theme.primary} attributes={TextAttributes.UNDERLINE} wrapMode="none">
            {formatPreviewPathLabel(ref.path, 34)}
          </text>
        </box>
      ))}
    </box>
  )
}
