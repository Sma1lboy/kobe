---
"@sma1lboy/kobe": patch
---

React port of the chat pane (issue #15, G3 wave 1). The full native-chat surface — transcript rendering AI SDK UIMessage parts verbatim, the multi-line composer (bash mode, `/` slash dropdown, `@` file mentions, per-key prompt history + ctrl+r palette, image paste, mid-turn queue, model picker, shift+tab permission cycle) — now exists under `src/tui-react/chat/`, sharing all framework-free composer logic with the Solid pane. The key router, composer props, queue-item shape, keybinding table, and placeholder resolver were extracted framework-free (Solid keeps consuming them), and `bun run dev:mock-react-chat` renders the React pane against a scripted fake harness turn. Solid remains the default; the workspace co-mount is unchanged.
