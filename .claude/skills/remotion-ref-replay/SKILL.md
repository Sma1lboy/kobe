---
name: remotion-ref-replay
description: Reproduce a reference screen-recording (product demo, feature walkthrough, marketing clip) as a Remotion composition driven by a real, scripted app session — so the video re-renders itself when the UI changes instead of being re-recorded by hand. Use when the user has a reference video and wants "the same video but on the current UI", "redo/replace/re-render a demo video", "turn this recording into Remotion", "capture a TUI/app demo", or is building any packages/branding replay composition. Covers reference-video analysis, the capture-script beat model, the stage-camera algorithm + weights, effect boundaries, and troubleshooting. See the quicklook-replay worked example for a concrete implementation.
metadata:
  internal: true
---

# remotion-ref-replay

**Goal:** given a reference screen-recording, rebuild it as a *programmatic*
video so it tracks the current UI. Manual re-recording is the thing we are
deleting — the subject changes with every UI iteration, and re-shooting by hand
is the pain. Instead: drive the **real** app with a scripted session, capture
frames, and render them with Remotion + a camera. UI iterates → re-run capture
→ re-render. No manual recording, ever.

This skill is the **method** and the **hard-won pitfalls**. It is engine- and
subject-agnostic: the first implementation replays a terminal UI (kobe TUI, via
tmux `capture-pane`), but the same pipeline applies to any app you can script
and snapshot (a web app via headless-browser screenshots, an Electron app, etc.)
— only the "capture" primitive changes.

Domain Remotion knowledge (animations, compositions, assets, fonts, ffmpeg)
lives in the **remotion-best-practices** skill — load it too. This skill is the
*replay-a-reference* layer on top of it.

**Worked example:** `packages/branding/` composition `quicklook-replay`
(`scripts/capture-tui.ts`, `src/quicklook/`). Read it for concrete code; read
*this* for the reasoning so a new adaptation doesn't re-derive it.

## The pipeline (three steps)

```bash
# in the Remotion package (e.g. packages/branding)
bun scripts/capture-<subject>.ts            # 1. capture -> src/<name>/frames.json
bun run studio                              # 2. preview the composition, tune the camera
bun x remotion render src/index.ts <id> out/<id>.mp4   # 3. render
```

Studio hot-reloads the camera/composition; `frames.json` only changes on re-capture.

## Step 0 — analyze the reference video FIRST (never skip)

Both the storyboard and the camera derive from what the reference actually
shows. The dominant failure mode is a *superficial* read that ships a video
doing the wrong thing — we paid for this more than once.

```bash
# 1 frame/sec is the right granularity — 1/2s misses beats; denser wastes context
ffmpeg -y -i <ref>.mp4 -vf fps=1 <dir>/s%02d.png
```

`Read` the stills in order and write down the **storyboard**: the ordered beats
(what the user does, what the screen shows, roughly when) and, for each beat,
*which pane/region is the subject*. This storyboard IS the input to both the
capture script and the camera stages — get it right before writing either.

Watch specifically for beats a shallow read collapses:
- A real **modal/page/dialog** vs. a shortcut that produces the same end-state.
  (In quicklook the "new task" beat is the real full-window NewTaskDialog, not
  an API call — the API call skips the on-screen page entirely.)
- **Pre-existing state** the video opens with (populated lists, prior items) —
  seed it, don't start from empty.
- **Input and waiting are animated** — typing appears char-by-char, spinners and
  loads actually run. That motion is the demo; don't paste instantly or jump-cut.

## Step 1 — the capture script (beat model)

Run the **real** app in an **isolated** context with **throwaway state** so it
never touches the user's real data. For a TUI: an isolated tmux server
(`-L <socket>`) + throwaway `HOME`/app-home dir, polling `capture-pane -ep`
(the `-e` keeps ANSI). Store a keyframe whenever the screen changes, stamped
with **wall-clock elapsed seconds** — NOT nominal frame indices; nominal time
drifts and typing/spinners replay at the wrong speed.

Interaction is a list of timed **beats**: `[atSecond, () => action]`. Fire them
fire-and-forget so a slow beat never stalls the polling loop.

Reusable gotchas (all cost us time at least once):
- **`cd` into the Remotion package before running** — script + `frames.json`
  paths are relative; a backgrounded run from the wrong cwd fails silently with
  "Module not found".
- **Bun Shell promises are lazy** — a beat that isn't awaited never runs. Force
  it (`.catch(() => {})`) so it executes without blocking the loop.
- **Drive real dialogs/pages, not stand-ins.** Reproduce the actual keystrokes
  (open, walk fields, confirm) and give the surface ~1.5–2s on camera before
  acting. A hand-rolled stand-in is both wrong and re-broken every UI change.
- **Type char-by-char** (`send-keys -l <char>` + delay): ~45ms/char for prompts
  (readable), slower (~160ms) for short deliberate commands.
- **Teardown fully** — kill every socket/process the run spawned (outer + inner
  tmux, the daemon, engine sessions) or they leak between runs.
- **Side effects persist** — created tasks/branches/files in the target repo are
  real sandbox artifacts. Per repo rules, do NOT delete them without an explicit
  instruction; surface them instead.

## Step 2 — the stage camera (algorithm + weights)

Where the taste lives. These rules are the *result* of wrong turns — the commit
history of the worked example shows each fix.

**Model: storyboard stages, not per-frame tracking.** The demo is scripted, so
the camera is too. A `STAGES` table of `{name, from, to, region?}` gives **one
fixed shot per stage**, eased between stages (`TRANSITION` ≈ 1.2s, smoothstep).
Per-frame "follow the motion" tracking was tried and **REJECTED — it twitches**:
every keyframe spawns a new target and the camera chases between clusters. Do
not reintroduce it.

**Framing a stage — `frameStage(from, to, region)`:**
1. Accumulate a **binary** changed-cell mask over the stage: a cell that changes
   at least once counts **once**. Weighting by change *count* lets an
   ever-repainting spinner / status bar / composer outweigh the real subject —
   a bug we hit. Binary fixes it.
2. Only look **inside the stage's `region`** (a grid rect for the subject pane).
   Chrome and unrelated panes are excluded so their noise can't win the frame.
   No region = a forced **wide** shot (use for full repaints / boot / the final
   pull-back).
3. Cluster changed rows into **bands** (row-gap > 3 splits a band), frame the
   **heaviest band**, then take the **5–95% column quantiles** within it so a
   stray edge glyph can't stretch the box.
4. Scale = fit the band into **~80%** of the viewport, **clamped to [1, 1.6]** —
   past ~1.6 mono glyphs alias; below 1 is a pull-back (express it as a wide
   stage instead).

**Aiming — translate, not transform-origin.** Center the target point (px) via
`translate(...) scale(...)` with the translate **edge-clamped so the viewport
never leaves the content**. `transform-origin` percentages were tried and
**REJECTED — they crop edge-adjacent targets** (a top-row target lost its top).
A target near an edge sticks to that edge instead of cropping.

**Tuning knobs (priority order when a stage looks wrong):**
1. Wrong subject → fix the stage's `region` (most common fix).
2. Too tight / loose → the `0.8` fit factor and `[1, 1.6]` clamp.
3. Subject cut in half, or noise merged in → the `> 3` row-gap.
4. Edge glyph stretching the box → the `0.05 / 0.95` column quantiles.
5. Move feels abrupt → `TRANSITION` seconds / the easing.

## Effect boundaries (what NOT to do)

- **No generative video (Seedance/i2v/etc.) for the UI surface** — it
  hallucinates text and layout; a product demo must be pixel-true. Generative
  passes are fine only for ambient/brand shots or transitions, never the UI
  frames. (Explicitly evaluated and set aside.)
- **Don't hand-paint a fake UI.** A static mock still needs hand-editing every
  iteration — which defeats the whole point. Capture the real app.
- **Camera stays inside the content rect** — never reveal black beyond the frame.
  The translate clamp enforces this; keep it.
- **One shot per stage.** If you want to move within a stage, that's two stages —
  split the table; don't animate the target mid-stage.
- **Respect engine/product-owned identity** (repo rule) — the app already renders
  the real vendor name/model; never overlay hard-coded vendor chrome.

## Troubleshooting (symptom → cause → fix)

| Symptom | Cause | Fix |
|---|---|---|
| Camera jitters/twitches | per-frame motion tracking | fixed shot per stage (Step 2 model) |
| Zoom lands on a spinner / status bar | change-count weighting | binary change mask (count each cell once) |
| Wrong pane framed | region too wide / unset | narrow the stage's `region` to the subject pane |
| Top/edge of subject cropped | transform-origin % framing | translate + edge-clamp (never leaves content) |
| Text mushy at zoom | scale > ~1.6 | clamp scale to [1, 1.6] |
| Subject cut in half | band split too eager | raise the row-gap threshold (`> 3`) |
| Box stretched by a stray glyph | no column trimming | 5–95% column quantiles within the band |
| "Module not found" running capture | wrong cwd (relative paths) | `cd` into the Remotion package first |
| A scripted beat never happens | Bun Shell promise not forced | `.catch(() => {})` to execute it |
| Typing/spinners replay too fast/slow | nominal frame timestamps | stamp keyframes with wall-clock elapsed |
| Engine sessions leak after a run | partial teardown | kill both tmux sockets + stop the daemon |
| Demo shows a fake/oversimplified dialog | stand-in instead of real surface | drive the real dialog's keystrokes |
| Frames show env noise (nags, banners) | non-pristine capture profile | clean app-home / suppress interstitials first |

## Production checklist (before a capture replaces a shipped asset)

- Bundle the app's actual font in the composition — headless Chrome's fallback
  mono has a different cell width and can clip trailing chars.
- Use a **pristine** app-home / suppress environment noise (update nags,
  auth warnings, promo banners, third-party interstitials).
- Re-run analysis if the reference changed; keep the storyboard table in sync
  with the capture beats and the camera stages (all three share it).
