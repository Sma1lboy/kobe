<p align="center">
  <img src="docs/assets/brand/bracket-chip.gif" alt="kobe" width="720" />
</p>

<p align="center">
  <strong>A TUI orchestrator for Claude Code, plus its branding pipeline.</strong>
</p>

---

This is a Bun-workspaces monorepo with two packages:

| Package | What it is | npm |
|---|---|---|
| [`packages/kobe`](./packages/kobe) | The kobe TUI itself — multi-task Claude Code in a 5-pane terminal app. | [`@sma1lboy/kobe`](https://www.npmjs.com/package/@sma1lboy/kobe) |
| [`packages/branding`](./packages/branding) | Remotion render pipeline for the brand artwork in [`docs/assets/brand/`](./docs/assets/brand/). | private |

If you're here to **use kobe**, read [`packages/kobe/README.md`](./packages/kobe/README.md).

If you're here to **work on it**, the orientation docs are at the repo root:

- [`HANDOFF.md`](./HANDOFF.md) — original briefing, the why behind the project
- [`CLAUDE.md`](./CLAUDE.md) — operating rules + memory pointers
- [`docs/DESIGN.md`](./docs/DESIGN.md) — design philosophy + architectural decisions
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — where each piece of code lives, and why
- [`docs/PLAN.md`](./docs/PLAN.md) — phase / wave plan and gate history
- [`docs/HARNESS.md`](./docs/HARNESS.md) — the agent self-test contract
- [`docs/themes.md`](./docs/themes.md) — user-installable themes (`~/.kobe/themes/` + `kobe theme add <url>`)

## Repo-level scripts

```bash
bun install               # installs both workspaces (one hoisted node_modules)
bun run dev               # alias for `bun --filter @sma1lboy/kobe dev`
bun run build             # alias for `bun --filter @sma1lboy/kobe build`
bun run typecheck         # alias for `bun --filter @sma1lboy/kobe typecheck`
bun run test              # alias for `bun --filter @sma1lboy/kobe test`
bun run test:behavior     # alias for `bun --filter @sma1lboy/kobe test:behavior`
bun run lint              # Biome across the whole monorepo
bun run lint:fix          # Biome --write across the whole monorepo
```

Per-package commands (Remotion renders for branding, etc.) live in each
package's `package.json` and are invoked with `bun --filter`.
