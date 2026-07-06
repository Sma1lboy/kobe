---
"@sma1lboy/kobe": patch
---

PIVOT (issue #16): remove the native chat layer — the Solid and React chat panes and the AI SDK harness backend (`engine/ai-sdk/`, `@ai-sdk/*` + `ai` dependencies) are deleted. kobe is a wrapper around the real engine CLIs: the KOBE_TUI workspace's center column becomes the seam for the upcoming embedded-terminal tab (in-process PTY running `claude`/`codex` directly), replacing self-rendered streams. Engine registry drops the `nativeChat` capability; shared model/effort types stay.
