# kobe — landing decks

Single-file, horizontal-swipe web PPTs for kobe, generated with the
[`guizang-ppt-skill`](https://github.com/op7418/guizang-ppt-skill) (歸藏). Two
style ideations of the same ~10-page narrative — open either `.html` directly in
a browser, no server needed (`open docs/ppt/index.html`).

Navigate: `←` / `→` arrows, scroll wheel, or touch swipe. `Esc` opens the slide
index. Each deck is fully self-contained (fonts/icons via CDN, Motion One with a
local fallback) and ships **zero image assets** — every page is text / data /
structure, so there is nothing to wire up.

| File | Style | Theme | Notes |
|------|-------|-------|-------|
| [`index.html`](./index.html) | 瑞士国际主义 · Swiss International | Klein Blue (IKB) | Sans-only, grid-locked, single accent. Press `B` for low-power (static) mode. |
| [`magazine.html`](./magazine.html) | 电子杂志 × 电子墨水 · Magazine | Indigo Porcelain | Serif titles + WebGL fluid hero backgrounds. |

Both tell the same story: the `Task = git worktree + engine session + branch`
triple, the 5-pane terminal-native TUI, the refcounted daemon, `kobe api`
fan-out, and per-repo init automation. Content is sourced from
[`packages/kobe/CHANGELOG.md`](../../packages/kobe/CHANGELOG.md) and
[`docs/DESIGN.md`](../DESIGN.md) — no fabricated metrics.

The `images/` folder is intentionally empty (placeholder for future screenshots).
