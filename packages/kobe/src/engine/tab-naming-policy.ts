import type { Message } from "@/types/engine"

export interface EngineTabNamingPolicy {
  /** When a known session should first be resolved into a readable title. */
  readonly trigger: "poll" | "immediate"
  /** Optional engine-specific backoff while an announced transcript lands. */
  readonly retryDelaysMs?: readonly number[]
  /** Project one neutral user message into title-worthy visible text. */
  readonly promptText: (message: Message) => string
}

export function defaultPromptText(message: Message): string {
  return message.blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ")
}

/** Backward-compatible policy for engines that do not declare one. */
export const DEFAULT_TAB_NAMING_POLICY: EngineTabNamingPolicy = {
  trigger: "poll",
  promptText: defaultPromptText,
}
