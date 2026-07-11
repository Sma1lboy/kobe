---
"@sma1lboy/kobe": patch
---

Keep attention badges sticky and restore codex turn/usage reporting. Tasks blocked on a permission prompt, rate limit, or error no longer decay to a plain idle badge after the 10-minute lapse timer — they stay lit until a real engine event clears them, so "come back and see who's stuck" survives long breaks. Codex rollout parsing now recognizes the real on-disk shapes: `event_msg` completion signals (task_complete / turn_complete / turn_aborted) so codex turns reach "done" again (background toast + unread badge fire), and `event_msg token_count` usage so the History panel shows non-zero tokens and carries the model context window.
