# quicklook-replay — capture + camera pipeline

See [`.claude/skills/quicklook-replay/SKILL.md`](../../../.claude/skills/quicklook-replay/SKILL.md)
for the full method (how to analyze a reference video, the capture-script beat
model, the stage-camera weighting/algorithm, and effect boundaries).

Quick reference:

```bash
# 1. capture a scripted TUI session into src/quicklook/frames.json
bun scripts/capture-tui.ts                 # default: two-task storyboard
bun scripts/capture-tui.ts --home .foo --seconds 120

# 2. preview / tune the camera
bun run studio                             # open quicklook-replay

# 3. render
bun x remotion render src/index.ts quicklook-replay out/quicklook-replay.mp4
```

Camera + framing algorithm lives in `src/quicklook/QuickLookReplay.tsx`
(`STAGES` table + `frameStage`). ANSI→spans parser in `src/quicklook/ansi.ts`.
