# Rove product identity and compatibility boundary

Rove is the canonical product name and `rove` is the canonical CLI command. Product data, distribution, and new git conventions use the Rove name; protocol, runtime-process, and plugin compatibility identifiers remain stable. Existing installations must open the same tasks and keep working with old integrations.

## Canonical surfaces

| Surface | Canonical value |
|---|---|
| Product display name | `Rove` |
| CLI examples, shell completions, and standalone compile output | `rove` |
| TUI, web, docs, landing page, notifications, and generated brand assets | `Rove` |
| Agent instructions and generated commands | `rove api …` |
| npm package | `@sma1lboy/rove` |
| Product state and config | `~/.rove`, `~/.config/rove/state.json` |
| New worktrees and branches | `~/.rove/worktrees/…`, `rove/…` |
| Per-repo init | `.rove/init.sh`, `.rove/init-prompt.md` |
| Plugin SDK | `@sma1lboy/rove-plugin-sdk` |
| Plugin authoring | `rove-plugin.toml`, `min_rove_version`, `rove-plugin` topic, `ROVE_PLUGIN_*` env |
| Agent skill id | `rove` |

## Compatibility surfaces

| Surface | Preserved value | Reason |
|---|---|---|
| Legacy executable | `kobe` | Existing scripts and global installs keep working |
| Legacy npm package | `@sma1lboy/kobe` | Published from the same build/version as `@sma1lboy/rove`, so existing global installs keep updating |
| Plugin SDK package | `@sma1lboy/kobe-plugin-sdk` | Published from the same SDK artifact/version as the Rove-named package |
| Existing state and config | `~/.kobe`, `~/.config/kobe` | First Rove launch copies supported product data without overwriting or removing the legacy source |
| Existing worktrees and branches | `~/.kobe/worktrees/…`, repo-local `.kobe`/`.claude`, `kobe/…` | Task records pin absolute paths and branch names; discovery recognizes every legacy root |
| Runtime process paths | daemon/PTY sockets, pidfiles, and logs under `.kobe` | Keeps an upgraded client attached to the same daemon and preserves hosted PTYs across upgrades |
| Environment and hook variables | `KOBE_*` | Engine-hook, daemon, and automation contracts stay stable; plugin commands receive both namespaces and SDK readers prefer `ROVE_*` |
| Protocol and persisted field names | `kobeVersion`, `minKobeVersion`, related established identifiers | Wire and manifest compatibility |
| Plugin discovery | `kobe-plugin.toml`, `min_kobe_version`, `kobe-plugin` topic | Canonical-first manifest resolution and dual-topic search keep existing plugins discoverable |
| Agent skill id and install paths | `kobe` | Existing installs are still detected and versioned; new installs use the `rove` id |
| Existing repository redirects and deployed website domains | `github.com/Sma1lboy/kobe`, `kobe.sma1lboy.me`, `docs.kobe.sma1lboy.me` | Old repository links keep redirecting and deployed domains remain reachable; new repository links use `github.com/Sma1lboy/rove` |

New user-facing copy must use Rove/`rove`. New compatibility identifiers should not use `kobe` unless they extend one of the established contracts above. Internal TypeScript symbols may retain `Kobe` when renaming them would create churn without changing a user-visible or serialized contract.

## Additive state migration

Migration has two additive phases. The CLI wrapper first copies missing
client-owned preferences, settings, themes, and attachments. Task metadata,
issues, notes, automations, and init markers are copied only when the new daemon
starts, after confirming that no old daemon still owns the socket; this prevents
a late legacy write from leaving the canonical store stale. Neither phase moves
or deletes the source or overwrites an existing Rove file. Worktrees are not
copied: existing task records continue pointing at their absolute legacy paths,
while new worktrees use the canonical root. Plugin directories and daemon/PTY
runtime files and plugin checkout/config/state directories remain under `.kobe`
because their absolute paths are part of the running-plugin compatibility contract.

## Package distribution migration

`packages/kobe/package.json` names `@sma1lboy/rove`, so workspace filters,
Changesets, update checks, install commands, and the first npm publish all use
the canonical package. The release job then rewrites only `package.json#name`
in its checkout and publishes the identical artifact as `@sma1lboy/kobe`.
Both packages contain the `rove` and `kobe` bins and use the same version and
dist-tag. The updater migrates legacy global installs to `@sma1lboy/rove`,
while users who never run it continue receiving releases through the alias.

## Plugin ecosystem migration

New plugins author `rove-plugin.toml` with `min_rove_version`, use the
`rove-plugin` GitHub topic, import `@sma1lboy/rove-plugin-sdk`, and receive
`ROVE_PLUGIN_*` variables. Every established Kobe spelling remains additive:
the host resolves both manifests with Rove winning, searches both topics,
injects identical `KOBE_PLUGIN_*` aliases, detects old `kobe` skill installs,
and publishes the same SDK artifact under both package names. Plugin data is
not copied or moved, so installed checkouts, config, state, and logs keep their
stable `.kobe` paths.

## Visual asset policy

Current product pages may only publish screenshots captured through the fixed-viewport browser harness described in [HARNESS.md](../HARNESS.md). The README and Quickstart use a fresh Rove workspace capture from that path; current animated placements use the generated Rove task-stream brand asset. Older TUI recordings remain checked in as historical artifacts, but current pages must not reference them because their rendered header still says `KOBE` and their direct-PTY capture path is no longer an accepted visual ground truth.
