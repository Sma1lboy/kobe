---
"@sma1lboy/kobe": patch
---

Gate the claude keychain-lookup unit test to macOS — the lookup bails before spawning `security` on other platforms, so the spy had nothing to assert on Linux CI and the v0.8.66 publish gate failed.
