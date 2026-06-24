# @sma1lboy/kobe-landing

Marketing landing page for **kobe** — served at **https://kobe.sma1lboy.me**.

A single self-contained static `index.html` (no build step, no framework). The
design started life as a Pretext `.dc.html` mockup; the dynamic bits (copy-to-clipboard
install button, engine selector that drives the `kobe api fan-out` snippet) were ported
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

The custom domain `kobe.sma1lboy.me` is a CNAME → `cname.vercel-dns.com`, managed in
AWS Route 53 (hosted zone `sma1lboy.me`).
