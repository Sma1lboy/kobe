---
"@sma1lboy/kobe": patch
---

Fix: the web bridge now rejects cross-origin requests, closing a CSRF / DNS-rebinding hole. The bridge's mutating routes (`/api/rpc` reaches task create/delete/archive/rename/setVendor, plus `/api/settings`, `/api/issues`, `/api/issue-assets`, `/api/session`) had no Origin check, so any page the user merely visited could drive them — and a rebound `attacker.com → 127.0.0.1` page would even count as same-origin. The bridge now applies the same defense the PTY sidecar already used: only loopback Origins (or the deliberately-configured `KOBE_WEB_HOST` LAN host) pass; Origin-less non-browser clients are still allowed. No change for normal localhost / Vite-proxy use.
