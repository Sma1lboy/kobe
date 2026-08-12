---
"@sma1lboy/kobe": patch
---

`kobe skill install` now installs globally (user-level) by default — the skill drives a machine-wide daemon, so one copy per machine keeps a single staleness lifecycle instead of re-prompting in every repo. `--project` opts back into a project-level install; the startup staleness prompt and onboarding install follow the same default.
