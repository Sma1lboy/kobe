# Entities — rove

Declarative shared contracts. Names follow the repository-prefixed CodeFox
join-key convention so implementation and downstream consumers match exactly.

| entity | kind | owner | note |
|---|---|---|---|
| rove.plugin-manifest | format | Rove maintainers | `rove-plugin.toml` plus the legacy Kobe filename and minimum-version field |
| rove.plugin-runtime-env | api | Rove maintainers | Canonical `ROVE_PLUGIN_*` variables and identical `KOBE_PLUGIN_*` aliases |
| rove.plugin-sdk | package | Rove maintainers | One SDK artifact published under canonical Rove and compatibility Kobe package names |
| rove.plugin-discovery | api | Rove maintainers | Union of the `rove-plugin` and `kobe-plugin` GitHub topics |
| rove.agent-skill | format | Rove maintainers | Canonical `rove` skill id with legacy Kobe install discovery |
