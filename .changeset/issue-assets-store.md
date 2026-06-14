---
"@sma1lboy/kobe": patch
---

The web bridge can now store images uploaded from the Issues panel: `POST /api/issue-assets` saves a raster image under `~/.kobe/issue-assets/` (scoped per repo) and returns a stable URL, served back by `GET /api/issue-assets/<repo>/<file>` with an immutable cache and `nosniff`. A 10 MiB cap and a raster-only allowlist (SVG is rejected as an XSS guard) keep the store safe.
