# Domain services

Routes authenticate and parse requests; services own account-scoped writes and their
transaction/serialization contracts. Shared pure calculations live in
[shared](../../../shared/README.md). Keep request-derived IDs qualified by the
authenticated account throughout every service call.

## Planning and daily comparisons

[caloriePlanningLock.ts](caloriePlanningLock.ts) serializes profile, goal, metric,
calorie-plan, and food-day changes for an account. Acquire this guard before metric
rows, food-day writes, or Wear revision checks; sample time and reread timezone
inside the guard. [goalStartingWeight.ts](goalStartingWeight.ts) corrects the active
goal baseline only when goal creation, metric date, and current local day all match.
Historical writes, body-fat-only changes, and KEEP imports do not correct it. A
late offline replay cannot assert an unverified original-submission date.

[dailyCaloriePlans.ts](dailyCaloriePlans.ts) retains the last server-observed plan
for each account-local date, including explicit unavailability and original
timezone/input revisions. Only current-day observations write this evidence;
previews, historical imports, and backfills cannot reconstruct it. Completion
freezes the retained comparison, separately recording observation and capture times.
Reopen/edit/recomplete preserves captured values, including unavailable results.
Timezone conflicts invalidate saved-value eligibility without rewriting provenance.

[foodDayComparison.ts](foodDayComparison.ts) serializes only saved evidence. The
client may display a labeled current-target fallback on completed or populated past
OPEN days; that fallback never enters API `calorie_comparison` or calendar bands.
Daily observations create no food-day row and change no inferred status or Wear revision.

## Weight trend and calibration

[materializedWeightTrend.ts](materializedWeightTrend.ts) bounds modeling to a
120-day active horizon plus 30-day warmup, anchored by the latest eligible reading.
Recomputation takes a transaction advisory lock at RepeatableRead and retries the
whole transaction on serialization/unique conflicts. Fit before replacing rows;
failure retains the last good batch. One source fingerprint binds metric IDs,
dates, and weights, including warmup. A same-date edit must invalidate it.

Metrics responses derive bands, counts, freshness and summary from one queried raw
snapshot. Historical end dates get an as-of pass; future local dates are excluded.
Unavailable trends retain factual observation recency and raw measurements but
expose null model estimates. Legacy fallback values must never masquerade as an
available trend. Older context has no invented model interval.

[calibration.ts](calibration.ts) bounds food evidence to the personal reference
horizon and weight evidence to the action window plus its boundary. Recommendation
fingerprints do not depend on unrelated goal-to-date descriptive reads. Apply/undo
revalidate the materialized recommendation; accepted revisions preserve configured
deficit and profile TDEE. Selecting `WEIGHT_TREND_MODEL=v1` suppresses v4 automatic
recommendations and stales pending ones without undoing accepted/scheduled plans.

## Replay, snapshots, and reminders

[clientOperations.ts](clientOperations.ts) claims an operation ID per user and hashes
its kind/canonical request. Claim, domain write, ordered SyncChange, and original wire
response commit atomically. Identical replay returns that receipt; changed input
conflicts. An in-flight claim remains retryable. Receipts and sync changes require an
explicit retention policy before pruning; the change feed is a reconciliation log.
Wear writes additionally compare entity revisions and reject stale overwrites.

In-app notification records are canonical. SSE, web push and native push only prompt
refresh/delivery; absence of provider configuration cannot prevent creation of the
record. Dedupe uses account, reminder and local day. [Notification clients](../../../mobile/src/notifications/README.md)
describe delivery capability negotiation and reminder limitations.

Food provider adapters are under [foodData](foodData/); nutrition OCR is under
[nutritionLabels](nutritionLabels/README.md). Account access/security is documented
once in [the backend README](../../README.md).
