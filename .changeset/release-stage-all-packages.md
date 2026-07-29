---
"@sma1lboy/kobe": patch
---

Release tooling: `release.sh` now stages every workspace package's version/CHANGELOG rewrite, fixing the 0.8.30 tag that pinned kobe to an uncommitted kobe-daemon bump (that release never reached npm; 0.8.31 supersedes it).
