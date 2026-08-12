---
"@sma1lboy/kobe": patch
---

Claude's running-row spinner no longer flashes a green color-emoji asterisk on Windows. The brand set's third frame `✳` (U+2733) is the only frame with the Unicode Emoji property, so Windows font fallback (Segoe UI Emoji) drew it in color — clashing with the surrounding monochrome frames in the sidebar and Inbox badges — and terminals there ignore the VS15 text-presentation request. The frame is now `✱` (U+2731 HEAVY ASTERISK), which has no emoji mapping anywhere and keeps the ·→✽ size ramp intact.
