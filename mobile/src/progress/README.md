# Progress and Plan check

Keep the compact Snapshot on the page background, with paired weight/date metrics, goal progress, current
target and one Edit goal action. For an active loss/gain goal, Edit goal contains the pace controls and an intentional Set a new goal action. Trend's heading, decorative fullscreen icon, and graph form one
full-width tap target with a shared hover/focus treatment. Trend fills the middle and expands in place
when tapped. Its entire chart, axes, and labels must remain visible; do not crop it behind a footer.
A full-width horizontal rule separates Snapshot from Trend, matching the rule above Plan check.
Collapsed and expanded Trend share one visualization: blue scale-reading dots and outlined estimate
band, green underlying trend, and the same axis scale and typography. Keep the overview compact with
no legend and only a small gap below the graph. Keep the collapsed section as one expansion target;
the wrapping legend, range controls, and reading selection belong in the expanded
view. Preserve at least 188px of plot on phones and 260px on desktop, scaling axis gutters and plot
height for enlarged text. Scroll the overview when its measured sections cannot fit together.
The detailed Trend content also gives its plot all remaining height after the range controls, legend,
selected reading, and point navigation. Keep a legible minimum and scroll short screens; do not cap
the plot height while leaving unused space below it.

`PlanCheckSummary` occupies the bottom area as one expansion target: heading, assessment period,
and available diagnosis or a useful pending/building/unavailable state. Keep this area stable when a
diagnosis is absent. Tapping expands Plan check in place; the overview does not contain the full evidence and
recommendation sequence. On short screens, including 320x568, Snapshot, Trend, and Plan check scroll
together, with Plan check following the complete chart below the fold. Enlarged text uses the same
intrinsic scrolling model. A rule marks the lower diagnosis area; do not repeat page rules for every
supporting label or metric group.

The Plan check detail page keeps assessment, paired recent/goal measurements, comparison, and next
step in that order. Group related evidence with 8–16px spacing and separate the next step with a 24px
gap. Use 16px supporting titles, 14px labels, and smaller target values than pace measurements. Keep
the recommendation open and its Review action full-width. Scheduled changes retain their status and
Undo action. Preserve all calculation, data-state, offline, attribution, and confirmation behavior.


## Product states

### Waiting

Waiting is shown until a decision-grade weight trend is available. The card sets expectations and names one structured blocker. It does not show provisional trend values, calorie balance, readiness meters, or countdowns.

A reliable assessment requires:

- A continuous current tracking period
- At least 14 elapsed days of weight history
- At least three weigh-ins
- A weigh-in no more than seven days old
- A sufficiently narrow weight-trend interval

A tracking pause or weight-trend segment reset restarts the assessment.

### On track

On track is shown when the retrospective weight-trend interval is sufficiently narrow and centered in the configured goal-rate band.

The card shows:

- The completed evidence period
- Recent weight trend midpoint
- The likely 95% range for that past trend
- The configured goal rate
- A no-change decision

The card explicitly says that the trend describes the period shown and is not a forecast.

### Off track

Off track is shown only when the full, sufficiently narrow trend interval supports a faster, slower, above-maintenance, or below-maintenance conclusion. An interval wider than the 300 kcal/day-equivalent limit stays in Waiting even if it is entirely beyond the goal band.

The target decision remains separate:

- change_available: a materialized recommendation can be reviewed
- no_change_recommended: the current target should be kept for now
- waiting: food evidence is not ready for a target decision
- safety_limited: the safety floor blocks a lower target
- policy_unavailable: automatic adjustments are unavailable for this goal

An off-track result does not imply that the calorie target is wrong.


## Recommendation behavior

The [shared evaluator](../../../shared/README.md#calibration-assessment) owns eligibility
and evidence thresholds; [backend services](../../../backend/src/services/README.md#weight-trend-and-calibration)
own materialization and accepted target revisions.

The card exposes one Review adjustment action. Apply is available only inside the review sheet and only when the response contains both an evaluator recommendation and top-level materialized recommendation metadata.

If a recommendation changes during review, the sheet closes and the new target requires a fresh review. Apply and Undo conflicts refresh the check; transient failures remain retryable.

Scheduled changes appear as a slim transactional banner. They do not replace the underlying assessment.


## Presentation and validation

Render typed assessment fields, never parse legacy server-authored headline/summary
prose. Give the retrospective comparison one accessible summary with the period,
midpoint/range, goal rate and conclusion; hide decorative chart internals. Color is
supplementary. Shared measurement and policy are in [shared](../../../shared/README.md).

`npm run dev:calibration-lab` renders the actual product component against deterministic
waiting, pause, sparse/stale/wide evidence, loss/gain/maintenance, BMR-floor, scheduled,
and maximum-window scenarios. With `CALIBRATE_CAPTURE_SCREENSHOTS=1`,
`npm run capture:calibration-lab` writes ignored screenshots. Check compact widths,
large text, review-sheet focus, changed recommendations, apply conflicts and Undo.
