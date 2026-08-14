# @sma1lboy/rove-plugin-sdk

## 0.1.2

### Patch Changes

- bc284d4: Make Rove the canonical plugin-authoring surface without breaking existing plugins: new manifests use `rove-plugin.toml` and `min_rove_version`, marketplace discovery searches `rove-plugin`, plugin commands receive `ROVE_PLUGIN_*`, and the bundled agent skill installs as `rove`. Legacy Kobe manifests, topics, environment variables, skill paths, and SDK imports remain supported; the SDK now publishes the same artifact as both `@sma1lboy/rove-plugin-sdk` and `@sma1lboy/kobe-plugin-sdk`.

## 0.1.1

### Patch Changes

- c9fbcb4: Contract catalog gains `task.landed`, `task.archived`, `issue.changed`, `tab.opened`, `tab.closed`, and `file.closed`.
- ad192f9: `promptUser(title, opts)` — the host input dialog as one typed call; contract catalog gains the `ui.prompt` channel.
