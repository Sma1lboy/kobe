# ADR 0002 — Engine-state policies (activity / triage / notify) stay separate

- Status: accepted
- Date: 2026-06-14

## Context

Three web modules switch over the same engine-state enum (`ActivityState`):

- `lib/activity.ts` — the status-dot **color** and human **label**.
- `lib/triage.ts` — the attention **bucket** for the rail's status chips.
- `lib/notify.ts` — whether a transition fires a **desktop notification**.

An architecture review suggested unifying them into one
`engineStateMeta(state) → { bucket, color, label, isNotifiable }` to kill the
apparent duplication.

## Decision

Keep the three policies separate. Only consolidate `activity.ts`'s own two
switches (color + label) into one `activityMeta`, since those are a single
presentation concern that should never drift apart.

The three modules look similar but encode **deliberately different** rules:

1. **The attention sets differ on purpose.** `triage`'s `attention` bucket is
   `{waiting_permission, error, rate_limited}`; `notify`'s `isAttention` is
   `{waiting_permission, error}` — `rate_limited` is flagged in the UI but must
   NOT trigger a desktop ping (it resolves itself; a notification would be
   noise). Merging into one `isNotifiable` would silently start notifying on
   rate-limiting — a regression.

2. **`triage` isn't a function of state alone.** Its `changes` / `quiet`
   buckets depend on worktree dirtiness (`{added, deleted}`), so it can't be
   expressed as a state-keyed meta record without dropping that input.

3. **Different lifecycles.** Presentation (activity) changes with the theme;
   triage priority is product UX; notification policy is opt-in + edge-triggered.
   Coupling them puts unrelated change pressure on one module.

## Consequences

- `activityMeta` is the single source for dot color + label; `activityColor` /
  `activityLabel` remain as thin accessors for call sites that need one.
- `triage` and `notify` keep their own predicates. If they ever need to share a
  helper, extract the *specific* shared predicate explicitly — do not fold them
  into one state-meta record, which would conflate the attention sets.
