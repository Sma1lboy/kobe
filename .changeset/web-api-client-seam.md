---
"@sma1lboy/kobe": patch
---

Internal: kobe-web bridge requests now go through one typed API client seam. Route clients describe JSON/query/body/fallback intent while shared code owns request construction, JSON/text error extraction, and status-shaped `ApiError`s.
