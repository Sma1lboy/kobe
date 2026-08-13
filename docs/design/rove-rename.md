# Rove product identity and compatibility boundary

Rove is the canonical product name and `rove` is the canonical CLI command. The rename is intentionally not a storage, protocol, package, or repository migration: existing installations must open the same tasks and keep working with old integrations.

## Canonical surfaces

| Surface | Canonical value |
|---|---|
| Product display name | `Rove` |
| CLI examples, shell completions, and standalone compile output | `rove` |
| TUI, web, docs, landing page, notifications, and generated brand assets | `Rove` |
| Agent instructions and generated commands | `rove api …` |

## Compatibility surfaces

| Surface | Preserved value | Reason |
|---|---|---|
| Legacy executable | `kobe` | Existing scripts and global installs keep working |
| npm packages | `@sma1lboy/kobe`, `@sma1lboy/kobe-plugin-sdk` | Renaming packages would require a separate distribution migration |
| State and config paths | `~/.kobe`, `~/.config/kobe` | One shared state tree; no migration or split-brain state |
| Environment and hook variables | `KOBE_*` | Plugin, engine-hook, daemon, and automation contracts stay stable; user-supplied variables also accept `ROVE_*` aliases |
| Protocol and persisted field names | `kobeVersion`, `minKobeVersion`, related established identifiers | Wire and manifest compatibility |
| Plugin discovery | `kobe-plugin.toml`, `kobe-plugin` topic | Existing plugins remain discoverable and installable |
| Agent skill id and install paths | `kobe` | Existing agent configuration finds the upgraded skill in place |
| Branch prefix | `kobe/` | Existing task and automation expectations remain stable |
| Repository, docs, and website URLs | Current `…/kobe` URLs | URL migration is independent of the product-copy rename |

New user-facing copy must use Rove/`rove`. New compatibility identifiers should not use `kobe` unless they extend one of the established contracts above. Internal TypeScript symbols may retain `Kobe` when renaming them would create churn without changing a user-visible or serialized contract.

## Visual asset policy

Current product pages may only publish screenshots captured through the fixed-viewport browser harness described in [HARNESS.md](../HARNESS.md). The README and Quickstart use a fresh Rove workspace capture from that path; current animated placements use the generated Rove task-stream brand asset. Older TUI recordings remain checked in as historical artifacts, but current pages must not reference them because their rendered header still says `KOBE` and their direct-PTY capture path is no longer an accepted visual ground truth.
