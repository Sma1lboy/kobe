---
"@sma1lboy/kobe": patch
---

Plugin system v1: a plugin is a directory with a `kobe-plugin.toml` manifest — no SDK, the whole `kobe` CLI is the plugin API (herdr-isomorphic manifest: `[[build]]`/`[[startup]]`/`[[actions]]`/`[[events]]`). New `kobe plugin` command (install from GitHub shorthand with preview+confirm, link for local authoring, list/enable/disable/unlink/uninstall/config-dir/log, action list/invoke); the daemon runs startup hooks and fires event hooks (`task.created`, `worktree.created`, `agent.turn-complete`, `agent.permission-needed`, …) derived from its push channels, with a file-watched registry so installs apply without a daemon restart. First-party examples under `plugins/` (notify, github-start, worktree-include); marketplace = GitHub topic `kobe-plugin`, browsable at kobe.sma1lboy.me/plugins.html. Design doc: docs/design/plugins.md.
