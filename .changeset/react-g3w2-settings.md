---
"@sma1lboy/kobe": patch
---

React port of the settings page behind KOBE_REACT=1 (issue #15, G3): `kobe settings` can boot the @opentui/react host with the full settings dialog (General / Engines / Accounts / Keybindings / Feedback / Dev), a React KVProvider backed by a framework-free kv-core with the same dirty-key-merge persistence as the Solid provider, and React ports of the confirm + rename dialogs. `bun run dev:mock-react-settings` renders the page against an isolated throwaway home.
