---
"@sma1lboy/kobe": patch
---

Fix the quick-task page's "type a prompt, hit enter" path: Enter in the prompt field was silently consumed by a no-op key binding instead of reaching the input's submit, so creating required tabbing to the engine field first; arrow keys also couldn't move the cursor inside the prompt/branch inputs. Engine and branch keep defaulting from the firing task — a prompt and one Enter is all a quick task needs now, as designed.
