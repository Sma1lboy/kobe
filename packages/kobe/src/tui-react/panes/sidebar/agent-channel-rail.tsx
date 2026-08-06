/** @jsxImportSource @opentui/react */
/** Compact top-level CHANNELS group shared by flat and tree sidebars. */

import type { AgentChannel } from "@/state/agent-channels"
import type { Task } from "@/types/task"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { SectionHeader } from "./chrome"

export function AgentChannelRail(props: {
  channels: readonly AgentChannel[]
  tasks: readonly Task[]
  selectedChannelId: string | null
  onSelectChannel?: (channel: AgentChannel) => void
}) {
  const { theme } = useTheme()
  const t = useT()
  if (props.channels.length === 0) return null
  const taskTitle = (taskId: string): string => props.tasks.find((task) => task.id === taskId)?.title ?? taskId
  return (
    <box flexDirection="column" flexShrink={0} maxHeight={7}>
      <SectionHeader label={t("channels.section")} />
      <scrollbox flexGrow={0} flexShrink={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
        <box flexDirection="column" flexShrink={0}>
          {props.channels.map((channel) => {
            const selected = channel.id === props.selectedChannelId
            const left = taskTitle(channel.endpoints[0].taskId)
            const right = taskTitle(channel.endpoints[1].taskId)
            return (
              <box
                key={channel.id}
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={selected ? theme.backgroundElement : undefined}
                onMouseUp={(event: { stopPropagation(): void }) => {
                  event.stopPropagation()
                  props.onSelectChannel?.(channel)
                }}
              >
                <text fg={selected ? theme.accent : theme.textMuted} wrapMode="none" flexShrink={0}>
                  {selected ? "●" : "○"}
                </text>
                <text
                  fg={selected ? theme.text : theme.textMuted}
                  attributes={selected ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  flexGrow={1}
                >
                  {left} ⇄ {right}
                </text>
              </box>
            )
          })}
        </box>
      </scrollbox>
    </box>
  )
}
