# @sma1lboy/kobe-landing

Marketing landing page for **Rove** — served at **https://rove.sma1lboy.me**.

A single self-contained static `index.html` (no build step, no framework). The
design started life as a Pretext `.dc.html` mockup; the dynamic bits (copy-to-clipboard
install button, engine selector that drives the `rove api fan-out` snippet) were ported
to a few lines of inline vanilla JS so the page deploys as plain static files.

## Local preview

```bash
bun run dev          # serves on http://localhost:4321
```

## Deploy

Hosted on Vercel as a static project (no build). The repo root is `packages/kobe-landing`.

```bash
bun run deploy           # production (vercel deploy --prod)
bun run deploy:preview   # preview URL
```

The custom domain `rove.sma1lboy.me` is a CNAME → Vercel's DNS
(`*.vercel-dns-016.com`), managed in Cloudflare (zone `sma1lboy.me`). The old
`kobe.sma1lboy.me` domain is kept as a Vercel-level 301 redirect to
`rove.sma1lboy.me`.

### Why `vercel.json` pins `ignoreCommand: "exit 1"`

Vercel's default monorepo skip-check runs `git diff --quiet HEAD^ HEAD -- .` to
avoid rebuilding when the root directory is untouched. The repo-root
`.vercelignore` allowlists only this directory, which strips `.git` from the
clone — so git exits non-zero with *"Not a git repository"* and **every**
deployment, on `main` and on every PR, reported as failed. This site is static
(`buildCommand: null`), so there is nothing to skip: `exit 1` means "always
build". `vercel.json` takes no comment keys (an unknown key fails validation
outright), which is why this note lives here.
