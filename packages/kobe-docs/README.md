# @sma1lboy/kobe-docs

Public docs site for kobe — https://docs.kobe.sma1lboy.me

Built with [Fumadocs](https://fumadocs.dev) (Next.js 16, static export via
`output: 'export'`). Branded through Fumadocs' official `--color-fd-*` CSS
theme variables in `app/global.css`; brand values derive from
`packages/kobe-landing/tokens.css`.

## Content model

The repo's `docs/` folder is the **only** source of truth. Nothing under
`content/docs/` is hand-written — `scripts/sync-docs.mjs` generates it
(gitignored) on every `dev`/`build`:

- copies the user-facing `docs/*.md` pages to `content/docs/*.mdx`,
- injects `title:` frontmatter from each file's first H1 (then strips it),
- rewrites links: synced pages → `/docs/<slug>` site paths, repo files →
  github.com blob URLs,
- copies the quick start to `index.mdx` so the docs home IS the quick start,
  and writes `meta.json` with the sidebar order.

To change docs content, edit `../../docs/`, never `content/docs/`.

## Commands

```bash
bun run sync     # regenerate content/docs from ../../docs
bun run dev      # sync + next dev
bun run build    # sync + static export to out/
bun run start    # serve out/ locally
bun run deploy   # manual fallback: build + vercel build/deploy --prebuilt --prod
```

## Deployment

Automatic: a push to `main` touching `docs/**` or `packages/kobe-docs/**`
triggers `.github/workflows/deploy-docs.yml` (Vercel prebuilt flow). No docs
change → no deploy. `bun run deploy` remains as a manual fallback.

Deploy uses the prebuilt flow because Vercel remote builds cannot see
`../../docs/` outside this package's root. The `.vercel/` directory holds the
production project link — do not delete it.
