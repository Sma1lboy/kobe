---
"@sma1lboy/kobe": patch
---

Fix: a prompt submitted from the web terminal composer no longer occasionally sits unsent in the composer. The bracketed paste and the Enter were written back-to-back, so they could coalesce into one tty read and the engine treated the carriage return as paste content instead of a submit. The Enter is now deferred ~150ms to land as a separate read — the same split the sidecar's `/pty/send` path already used.
