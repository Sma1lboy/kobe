---
name: quicklook-replay
description: Reproduce a product-demo screen recording as a Remotion composition driven by a real, scripted kobe TUI session — so the demo re-renders itself when the UI changes instead of needing a manual re-record. Use when asked to "redo the quicklook video", "replace the landing demo", "re-render the product demo", "capture a TUI demo", or to work on packages/branding's quicklook-replay. Covers reference-video analysis, the capture-script beat model, the stage-camera algorithm + weights, and effect boundaries.
metadata:
  internal: true
---

# quicklook-replay

Turn a hand-recorded product demo (`packages/kobe-landing/assets/quicklook.mp4`,
a manual 52s screencast of the **old** UI) into a **programmatic** video that
tracks the current TUI. Manual screen-recording is the thing we are deleting:
the middle of the landing page changes with every UI iteration, and re-recording
by hand is the pain. Instead we drive the **real** kobe TUI with a scripted
session, capture ANSI frames, and render them with Remotion + a camera. UI
iterates → re-run capture → re-render. No manual recording, ever.

Everything lives in `packages/branding/`:

- `scripts/capture-tui.ts` — drives the real TUI, writes `src/quicklook/frames.json`
- `src/quicklook/ansi.ts` — SGR/ANSI → styled spans (no full terminal emulator)
- `src/quicklook/QuickLookReplay.tsx` — renders frames + the stage camera
- registered in `src/Root.tsx` as composition `quicklook-replay`

## The pipeline (three steps)

```bash
cd packages/branding
bun scripts/capture-tui.ts                 # 1. capture -> src/quicklook/frames.json
bun run studio                             # 2. preview quicklook-replay, tune camera
bun x remotion render src/index.ts quicklook-replay out/quicklook-replay.mp4   # 3. render
```

Studio hot-reloads the camera; `frames.json` only changes when you re-capture.

## Step 0 — analyze the reference video FIRST (do not skip)

The camera and the storyboard both derive from what the reference actually
shows. Read it properly — the failure mode is a superficial read that produces
a demo doing the wrong thing.

```bash
# 1 frame/sec is the right granularity — 1/2s misses beats, denser wastes context
ffmpeg -y -i <ref>.mp4 -vf fps=1 <dir>/s%02d.png
```

Then `Read` the stills in order and write down the **storyboard**: the ordered
list of beats (what the user does, what the screen shows, roughly when), and
for each beat *which pane/region is the subject*. The current
`quicklook.mp4` storyboard, for reference:

1. `$ kobe` typed in a shell → launch
2. workspace wide — sidebar has several projects + several tasks (some pre-existing)
3. **new task created via the real NewTaskDialog** (`n` → tabs/engine/repo/branch → Create) — this opens a dedicated full-window page, NOT a set-active shortcut
4. engine boots in the worktree (bun install → Claude/Codex welcome)
5. prompt typed into the composer — **the typing itself is on screen, char by char**
6. agent works — tool-call stream (Explore subagent, Read/Bash), spinners tick
7. a second task created the same way, different engine (codex)
8. wrap

Load-bearing facts that a shallow read gets wrong (learned the hard way):

- **New task = a real page.** The video shows the NewTaskDialog full-window
  surface. Do NOT fake it with `kobe api add` alone or `set-active` — those
  don't render the dialog. Drive `n` and walk the fields (see below).
- **Multiple tasks, some pre-existing.** Seed the sidebar (`kobe api add
  --status in_progress` with no `--prompt` = a row, no engine) so it isn't
  empty, then create the new one on camera.
- **Input and waiting are animated.** Type prompts char-by-char (`send-keys -l`
  per char with a delay), and let real spinners/boot output run — don't paste
  instantly or jump-cut past the wait. That motion is the point.

## Step 1 — the capture script (beat model)

`scripts/capture-tui.ts` runs the real TUI in an **isolated tmux server**
(`-L kobe-capture`) with a **throwaway `KOBE_HOME_DIR`** so it never touches
`~/.kobe`. It polls `tmux capture-pane -ep` (the `-e` keeps ANSI) and stores a
keyframe whenever the screen text changes, stamped with **wall-clock elapsed
seconds** (so typing and spinners replay at true speed — do NOT use nominal
frame indices, they drift).

Interaction is a list of timed **beats**: `[atSecond, () => action]`. Beats
fire fire-and-forget (`.catch(() => {})` — Bun Shell promises are lazy, so you
must force them) so a slow beat never stalls the polling loop.

Gotchas baked into the script (keep them):

- **`cd` into `packages/branding` before running** — the script and
  `frames.json` paths are relative. A backgrounded run without `cd` silently
  fails with "Module not found".
- Open on a **plain `sh`** with a clean `PS1`, type `kobe`, then `Enter` — the
  real product-launch beat. Pass `PATH`/`PS1` via `-e` on `new-session`.
- **Driving the NewTaskDialog**: `n` opens it. Enter advances through
  tabs → engine → repo → branch → Create; a final Enter commits. Arrow the
  engine picker with `Right` before advancing to pick codex. Give the dialog
  ~1.5–2s open on camera before touching it.
- **Typing**: `send-keys -l <char>` one char at a time, ~45ms/char for prompts
  (readable), ~160ms/char for the short `kobe` launch (deliberate).
- **Teardown**: `tmux kill-server` on both the outer socket AND the inner
  `KOBE_TMUX_SOCKET`, plus `kobe daemon stop`, or engine sessions leak.
- **Side effects**: each created task makes a real branch in `--repo`. These
  are sandbox artifacts; per repo rules do NOT delete them without being told.

## Step 2 — the stage camera (algorithm + weights)

This is where taste lives. The rules below are the result of several wrong
turns; the commit history in this worktree shows each fix.

**Model: storyboard stages, not per-frame tracking.** The demo is scripted, so
the camera is too. `STAGES` is a table of `{name, from, to, region?}`. One
**fixed shot per stage**, eased between stages (`TRANSITION` ≈ 1.2s,
smoothstep). Per-frame "follow the motion" tracking was tried and **rejected —
it twitches**, because every keyframe spawns a new target and the camera
chases between clusters. Do not reintroduce it.

**Framing a stage — `frameStage(from, to, region)`:**

1. Accumulate a **binary** changed-cell mask over the stage's frames: a cell
   that changes at least once counts **once**. (Weighting by change *count*
   lets an ever-repainting spinner/status-bar/composer outweigh the real
   subject — a bug we hit. Binary fixes it.)
2. Only look **inside the stage's `region`** (a grid rect). Chrome and unrelated
   panes are excluded so their noise can't win the frame. Regions in use:
   `FULL`, `CHAT` (workspace conversation), `DIALOG` (centered NewTaskDialog),
   plus sidebar-only rects as needed. No `region` = forced **wide** shot (used
   for boot repaints and the final pull-back).
3. Cluster changed rows into **bands** (gap > 3 rows splits a band), frame the
   **heaviest band**. Then take the **5–95% column quantiles** within that band
   so a stray edge glyph can't stretch the box.
4. Scale = fit the band into **~80%** of the 1280×720 viewport, **clamped to
   [1, 1.6]** — never zoom past 1.6 or text turns to mush; never < 1 (that's a
   pull-back, express it with a wide stage instead).

**Aiming the camera — translate, not transform-origin.** The shot is a target
point (px) centered via `translate(...) scale(...)` with the translate
**edge-clamped so the viewport never leaves the content**. `transform-origin`
percentages were tried and **rejected — they crop edge-adjacent targets** (the
typed `$ kobe` on row 0 lost its top). A target near an edge sticks to that
edge instead of cropping.

**Tuning knobs (in priority order when a stage looks wrong):**

1. Wrong subject → fix the stage's `region` (most common fix).
2. Too tight / too loose → the `0.8` fit factor and the `[1, 1.6]` clamp.
3. Band split wrong (subject cut in half, or noise merged in) → the `> 3` row-gap.
4. Edge glyph stretching the box → the `0.05 / 0.95` column quantiles.
5. Move feels abrupt → `TRANSITION` seconds / the `easeInOut`.

## Effect boundaries (what NOT to do)

- **No generative video for the product surface.** Seedance/i2v and friends
  hallucinate UI text and layout; a product demo must be pixel-true. Generative
  passes are fine only for ambient/brand shots or transitions, never the UI
  frames themselves. (This was explicitly evaluated and set aside.)
- **Don't hand-paint a fake TUI.** `PaneGrid.tsx` (a static React terminal
  mock) exists for brand animation, but a hand-drawn UI still needs hand-editing
  every iteration — which defeats the whole point. Capture the real TUI.
- **Camera stays inside the content rect** — no reveal of black beyond the
  1280×720 frame. The translate clamp enforces this; keep it.
- **Zoom ceiling 1.6, floor 1.0.** Past 1.6 the mono glyphs alias badly.
- **One shot per stage.** If you feel the need to move within a stage, that's
  two stages — split the table, don't animate the target mid-stage.
- **Respect engine-owned identity** (repo rule): the TUI already renders the
  real vendor name/model; never overlay hard-coded "Claude"/"Codex" chrome.

## Known follow-ups before this replaces the landing asset

- Bundle JetBrains Mono in the composition — headless Chrome falls back to a
  system mono whose cell width differs slightly, occasionally clipping 1–2
  trailing chars.
- Clean capture profile — the real run picks up environment noise (skill-update
  nag, MCP-auth warning, Fable promo banner, codex update interstitial). Use a
  pristine `KOBE_HOME` / suppress those before a production capture.
- Trim the codex update-nag interstitial from that stage or pre-accept it.
