/**
 * Vendor-neutral content blocks.
 *
 * `Message.blocks` on the wire / on-disk side is a discriminated union
 * over this type. Vendor adapters (currently `engine/claude-code-local/`)
 * are responsible for normalizing their native shape (Claude Code's
 * content-block array) into this form — see
 * `engine/claude-code-local/normalize.ts`.
 *
 * Why these four and not Anthropic's full taxonomy: each one maps to a
 * UI affordance (text row, tool banner, tool result body, thinking dots).
 * `image` / `redacted_thinking` / citation blocks were dropped by
 * kobe's renderers anyway — leaving them out of the neutral type makes
 * "we don't render this" explicit instead of accidental.
 *
 * Why `tool_result.output: unknown`: tool outputs are engine- and
 * tool-specific (Bash returns a string, Edit returns a diff blob, MCP
 * tools return arbitrary JSON). Renderers in `tui/panes/chat/` narrow
 * per tool. We don't try to project that into a neutral shape here.
 */

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_call"
      /** Stable id linking a tool_call to its later tool_result. */
      readonly callId: string
      /** Tool name as the vendor reported it (e.g. "Bash", "Edit"). */
      readonly name: string
      /** Vendor-shaped tool args. Renderers narrow per tool. */
      readonly input: unknown
    }
  | {
      readonly type: "tool_result"
      readonly callId: string
      /** Vendor-shaped output. Renderers narrow per tool. */
      readonly output: unknown
      readonly isError: boolean
    }
  | { readonly type: "thinking"; readonly text: string }
