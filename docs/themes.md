# Themes

kobe bundles three color themes (`claude`, `conductor`, and
`tokyonight`) and lets you drop additional ones into `~/.kobe/themes/`
without recompiling. The bundled set is deliberately small; everything
else is one `kobe theme add` away (see [Hosted themes](#hosted-themes)). Any
file matching `~/.kobe/themes/*.json` is loaded at boot and shows up in
the theme picker (`Settings → General → Theme`, opened via `ctrl+,`).

If a user theme has the same name as a bundled theme, the user's wins.

## JSON shape

A theme is a JSON object with two top-level fields:

```json
{
  "$schema": "https://raw.githubusercontent.com/sma1lboy/kobe/main/packages/kobe/src/tui/context/theme/theme.schema.json",
  "defs": {
    "brand": "#cc785c"
  },
  "theme": {
    "background": "#141413",
    "text": "#eae7df",
    "primary": "brand",
    "accent": { "dark": "#cc785c", "light": "#c96442" }
  }
}
```

- **`defs`** (optional): a palette of named colors that `theme` entries
  can reference by name. Values are hex strings.
- **`theme`** (required): the slot map. Each value is either a hex
  string (`#abc`, `#aabbcc`, `#aabbccdd`), a bare string referencing a
  key in `defs`, or a `{ dark, light }` pair for theme-mode-aware
  colors. Both `dark` and `light` are required when you use the variant
  form.
- **`$schema`** (optional): pointer back to kobe's JSON schema for
  editor autocomplete. The canonical URL is the one above.

You don't have to fill every slot; kobe has fallbacks (e.g.
missing `borderActive` falls through to `border`, missing `border`
falls through to `text`). The full slot list with fallbacks lives in
[`packages/kobe/src/tui/context/theme.tsx`](../packages/kobe/src/tui/context/theme.tsx).
The canonical example is
[`packages/kobe/src/tui/context/theme/claude.json`](../packages/kobe/src/tui/context/theme/claude.json).
Copy it as a starting point.

## CLI

```sh
# List bundled + user-installed themes
kobe theme list

# Install from a URL or local path. Default name is the basename.
kobe theme add https://raw.githubusercontent.com/<you>/<repo>/main/<theme>.json
kobe theme add ./my-theme.json --name darkside

# Overwrite an existing user theme
kobe theme add ./darkside.json --force

# Remove a user-installed theme (built-ins can't be removed)
kobe theme remove darkside
```

`kobe theme add` validates the JSON before writing and refuses to
overwrite without `--force`. Invalid themes are rejected with a
one-line reason; the schema rules are the same ones the boot-time
loader applies.

## Publishing on GitHub

1. Commit your theme JSON to a public repo (or gist).
2. Click "Raw" on GitHub and copy the URL. It should look like
   `https://raw.githubusercontent.com/<you>/<repo>/main/<theme>.json`.
3. Share `kobe theme add <raw-url>` with anyone who wants to install it.

That's the entire distribution mechanism: no plugin manifest, no
registry. The same shape is what kobe ships internally; your theme
doesn't have to know it's a "user" theme.

## Hosted themes

Ten themes are hosted on the landing site rather than bundled:
`catppuccin`, `dracula`, `everforest`, `gruvbox`, `kanagawa`, `nord`,
`opencode`, `osaka-jade`, `rose-pine`, `solarized`. Install any of them
with one command:

```sh
kobe theme add https://kobe.sma1lboy.me/themes/gruvbox.json
```

Several of these shipped bundled before v0.8.38. Nothing about them
changed except where they live, and installing one restores it exactly.
Their sources are in `packages/kobe-landing/themes/`, and the gallery at
<https://kobe.sma1lboy.me/themes> previews all thirteen, rendered from
these same JSON files.

## Troubleshooting

- **Theme doesn't show up**: check `kobe theme list` to confirm the
  file is being read. If it's missing, re-check the file extension
  (`.json`) and the directory path printed by `kobe theme list`.
- **Theme rejected at boot**: kobe writes a `console.warn` line to
  stderr with the file path and the rejection reason. Run
  `kobe diagnose` for a full environment report and check the recent
  output above where you ran `kobe`.
- **Want to override a built-in?** Drop a file with the same name
  (e.g. `~/.kobe/themes/claude.json`). User files load after bundled
  ones and win on collisions.
