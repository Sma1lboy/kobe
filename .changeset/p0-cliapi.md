---
"@sma1lboy/kobe": patch
---

Harden `kobe api` prompt delivery and fan-out: verify a pasted prompt actually landed in the engine composer (strict engine-pane lookup, no blind first-pane fallback), size the readiness wait to the repo init-script budget, and surface a dropped prompt as a non-zero exit instead of a phantom success. Fan-out now delivers prompts concurrently and reports partial failures with each created task's id (exit 3) rather than losing them. `kobe api add` no longer steals the active-task focus by default — pass `--activate` to opt in.
