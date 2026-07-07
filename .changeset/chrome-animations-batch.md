---
"@sma1lboy/kobe": patch
---

Chrome animations, first batch (design review follow-up): the sidebar running badge now animates with the task engine's own brand spinner (claude gets Claude Code's `·✢✳✶✻✽` star oscillation; other engines keep braille) via a new engine-registry `spinnerFrames` slot; a background tab's turn-complete ✓ pulses emphasized for ~600ms when it lands; toasts slide in from the right; a materializing worktree row shows an indeterminate partial-block comet sweep ahead of the word. All of it sits behind a new Settings → General → Reduced motion toggle (persisted + daemon-fanned like theme/transparent) that degrades the spinner to Claude Code's slow pulsing-dot form and turns the other effects off. Also: the file tree's `−N` deletion counter now uses the same typographic minus as the sidebar.
