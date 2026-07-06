export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_call"
      readonly callId: string
      readonly name: string
      readonly input: unknown
    }
  | {
      readonly type: "tool_result"
      readonly callId: string
      readonly output: unknown
      readonly isError: boolean
    }
  | { readonly type: "thinking"; readonly text: string }
