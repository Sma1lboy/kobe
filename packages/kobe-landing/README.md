# @sma1lboy/kobe-landing

Marketing landing page for **Rove** — served at **https://kobe.sma1lboy.me**.

A single self-contained static `index.html` (no build step, no framework). The
design started life as a Pretext `.dc.html` mockup; the dynamic bits (copy-to-clipboard
install button, engine selector that drives the `rove api fan-out` snippet) were ported
to a few lines of inline vanilla JS so the page deploys as plain static files.

## Local preview

```bash
bun run dev          # serves on http://localhost:4321
```

## Deploy

Hosted on Vercel as a static project (no build). The Vercel project Root
Directory is `packages/kobe-landing`, and that setting also applies to the CLI.
The package scripts therefore keep the convenient package-local entry point but
pass `--cwd ../..` so Vercel starts at the monorepo root and applies the project
Root Directory exactly once.

Link the monorepo once from its root with `vercel link --repo`. Then, from this
package, run:

```bash
bun run deploy           # production
bun run deploy:preview   # preview URL
```

The custom domain `kobe.sma1lboy.me` is a CNAME → `cname.vercel-dns.com`, managed in
AWS Route 53 (hosted zone `sma1lboy.me`).

### Why `vercel.json` pins `ignoreCommand: "git diff --quiet HEAD^ HEAD -- ."`

Vercel's default monorepo skip-check runs `git diff --quiet HEAD^ HEAD -- .` to
avoid rebuilding when the landing directory is untouched. Exit zero skips the
deployment; a changed directory or unavailable parent commit exits non-zero and
deploys. The repo-root `.vercelignore` keeps `.git` and this package in the CLI
upload so the check has the history and files it needs. `vercel.json` takes no
comment keys (an unknown key fails validation outright), which is why this note
lives here.
