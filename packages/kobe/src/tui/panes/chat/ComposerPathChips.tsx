import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { formatPreviewPathLabel } from "./composer/path-preview"

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
  return (
    <Show when={props.hasTask && props.refs.length > 0}>
      <box flexDirection="row" gap={1} alignItems="center" paddingBottom={1}>
        <text fg={theme.textMuted} wrapMode="none">
          open
        </text>
        <For each={props.refs}>
          {(ref) => (
            <box
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
          )}
        </For>
      </box>
    </Show>
  )
}
