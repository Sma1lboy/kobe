---
"@sma1lboy/kobe": patch
---

fix: the kobe skill now claims agent-to-agent messaging in its DESCRIPTION, not just its body. A skill contributes one line to an agent's context until it loads; an MCP server contributes its whole instruction block permanently. So "message another session on this machine" read as unclaimed territory and a generic peer-channel MCP won it by default — while the rule forbidding exactly that sat in the un-loaded body. Skill version 19 → 20 (installed copies will prompt to update).
