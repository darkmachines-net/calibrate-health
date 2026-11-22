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

Expanded Trend uses fixed 7-, 28-, and 365-day windows. The date arrows move a full
window; dragging or swiping slides by date and snaps to a day on release. Changing
the span keeps the visible end date within the history bounds. Back to today returns
to the account-local current day. The chart caches 56-day pages and prefetches
neighbors; gaps keep their calendar space, including when a window has no readings.

`PlanCheckSummary` is one expansion target showing available durations, a fresh-weigh-in
prompt, or a first-week waiting state. Keep it available even when the calorie plan
needs review. On short screens Snapshot, Trend, and Plan check scroll together.

The expanded Plan check shows 7, 14, and 28 completed-day windows after each duration
has elapsed since the first tracked weight, food entry, or completed food day. Before
seven days it shows no trend. Durations are calendar days in the account's IANA timezone.
Food averages include populated days and explicitly completed empty days; missing days
are unknown, not zero. Show logged-day and completed-day coverage alongside every average.
Pauses and partial logs do not restart history or block weight summaries.

Weight rates use a straight-line fit through recorded readings within the window,
including today's reading if present. Require a weigh-in today or yesterday and at least
two readings spanning half the window. Older evidence prompts a direct Log weight action;
clustered evidence asks for readings spread through the period. Never label a user on/off
track or offer calorie-target changes. Keep dates, reading counts and coverage visible.

The weekly-report section shows saved Sunday analysis and lets users reopen the latest
12 reports. Reports are clearly labeled AI-generated; ordinary reads never generate them.
Hide the empty section when the server has not configured scheduling. Preserve saved
reports when scheduling is disabled. [Backend reports](../../../backend/src/services/weeklyReports/README.md)
own eligibility, provider data, account consent, persistence and retry semantics.

All sections reflow at 320px and enlarged text; use the shared section and notice primitives.
Pending offline food/weight writes hide stale summaries until sync completes. Local-day
query keys refresh eligibility at midnight. The existing calibration query-key prefix is
retained so food, weight and profile mutations invalidate the new summary consistently.

Run the PlanCheckCard and PlanCheckSummary component tests, Progress browser layout and
expansion tests, and the UX visual/accessibility gates. `npm run dev:calibration-lab`
previews the current descriptive component against synthetic histories; legacy evaluator
output is retained below it solely as historical diagnostics.
