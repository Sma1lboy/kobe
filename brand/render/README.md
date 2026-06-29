# kobe — branding

Animated logo concepts for kobe, built in [Remotion](https://www.remotion.dev/). Four directions, all
drawn from the project's actual aesthetic: terminal-first, agent-deck-style brackets / BOLD CAPS,
tokyonight palette, multi-pane orchestration as the product story.

> kobe is a codename — when the product gets a real name, the wordmark swaps; the *grammar* of each
> concept (bracket chip, pane grid, parallel streams, K-glyph) survives the rename.

## Concepts

| id | concept | what it sells |
|---|---|---|
| `bracket-chip` | `[ kobe| ]` typing in with a blinking cursor | The agent-deck `[Tab] label` hotkey grammar that runs through the whole TUI. Reads as "press me." |
| `pane-grid` | The 5-pane TUI draws itself, wordmark settles into the workspace | The literal product. If the pitch is "Conductor-shaped 5-pane TUI for Claude Code," show it. |
| `task-streams` | Three parallel `● task-N ────►` lanes converging into the wordmark | The multi-task / orchestration value prop — many sessions in flight, one place to drive them. |
| `glyph-k` | A bold "K" assembled from terminal box-drawing chars, pulsing | Square app-icon shape. Works as favicon / dock tile / GitHub social card. |

All four use the tokyonight palette (`src/colors.ts`) so the assets stay consistent with the running TUI's default theme.

## Render

```bash
cd brand/render
bun install            # or pnpm install / npm install
bun run studio         # interactive preview at http://localhost:3000
```

One-shot renders write committed assets to `public/brand/`:

```bash
bun run render:all     # all four MP4s
bun run stills:all     # PNG stills (frame chosen near the settled state)
```

Per-concept:

```bash
bun run render:bracket   # bracket-chip.mp4
bun run render:grid      # pane-grid.mp4
bun run render:streams   # task-streams.mp4
bun run render:glyph     # glyph-k.mp4
```

## Canvases

| concept | size | duration |
|---|---|---|
| bracket-chip | 1200×630 (OG card / wide banner) | 4s |
| pane-grid | 1200×800 | 5s |
| task-streams | 1200×630 | 4s |
| glyph-k | 800×800 (square / app icon) | 5s |

Override at render time with `--width`, `--height`, `--frames`. For a transparent PNG sequence
suitable for compositing into docs / screenshots, render with `--image-format=png` and
`--codec=png-sequence`.

## Picking one

If only one ships first, **`bracket-chip`** is the most defensible — it's smallest, most recognizable,
and aligns directly with the in-app hotkey grammar (`[Tab] chat`, `[1] sidebar`, etc.). `glyph-k` is
the natural companion for the square app-icon slot.

`pane-grid` and `task-streams` are *story* logos — better for README hero / docs / landing page than
for the dock.

## Files

```
brand/render/
├── README.md          ← you are here
├── package.json
├── tsconfig.json
├── remotion.config.ts
└── src/
    ├── index.ts       ← registerRoot
    ├── Root.tsx       ← <Composition> registry
    ├── colors.ts      ← tokyonight palette + mono font stack
    ├── BracketChip.tsx
    ├── PaneGrid.tsx
    ├── TaskStreams.tsx
    └── GlyphK.tsx
```

The branding subproject has its own `package.json`, `tsconfig.json`, and `node_modules` so it stays
isolated from the main kobe build (vitest only scans `test/**`, root tsconfig only includes
`src/**` + `test/**`).
