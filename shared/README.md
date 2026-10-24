# Shared domain

This package contains pure rules used by the backend and Expo clients. Units at
persistence boundaries are grams and millimeters; display conversion belongs at the
API/UI edge. [date.ts](date.ts) owns account-timezone local dates. [domain.ts](domain.ts)
owns domain values; [goalDeficit.ts](goalDeficit.ts) restricts signed daily deficit
magnitudes to 0, 250, 500, 750 and 1000 kcal. Positive is loss, negative is gain.

## Calorie and release policy

[caloriePolicy.ts](caloriePolicy.ts) enforces planning safety. Profile-estimated TDEE
is Mifflin-St Jeor BMR times activity multiplier; baseline target subtracts the signed
deficit. User-approved calibration can add a bounded correction without changing TDEE
or configured deficit. Activity never earns back calories. Goal projection uses the
fixed energy conversion and maintenance has no projected date.

[release.json](release.json) owns canonical server/native identity; package, Expo,
Gradle, diagnostic and API values are mirrors checked by `npm run release:check`.
[releaseCompatibility.ts](releaseCompatibility.ts) requires matching major versions
and a server minor at least as new as the running bundle's expected minor; patch drift
is compatible. This is distinct from minimum native versions and API negotiation.
Expo owns downloads; compatibility is checked only on a running bundle. Release
operations are documented beside [workflows](../.github/workflows/README.md).

## Weight trend

[weightTrend.ts](weightTrend.ts) is a forward-only local-linear Kalman model with
state [kg, kg/day]. It propagates covariance over actual elapsed time; a gap over
14 days starts an independent segment. Initialization consumes the first reading
once. A preliminary pass estimates causal innovation MAD, clamps measurement noise,
shrinks toward the default, then the final pass uses that per-date variance sequence.
Huber weighting retains finite spikes while limiting their influence. Appending a
reading cannot revise earlier emitted points.

The 95% band estimates underlying weight, not the next scale reading. Short-term
reading variability is separate. The latest velocity state supplies public current
weekly pace; calibration instead requests a robust average slope and bootstrap over
its exact uninterrupted food-evidence window. Pre-window data cannot affect that
regression or seed. A reset inside the window makes it unavailable, never substitutes
instantaneous pace. [weightTrendParameters.ts](weightTrendParameters.ts) owns numeric
values and the approved fingerprint; change the model version when tuning constants.
Persistence and response consistency live in [backend services](../backend/src/services/README.md#weight-trend-and-calibration).

Run `npm run test:weight-trend-lab` and `npm run weight-trend:tuning-report:check`.
The reproducible machine fixture is `backend/test/fixtures/weight-trend-v2-tuning-report.json`.
An intentional fixture/model change can regenerate it with
`npm --prefix backend run weight-trend:tuning-report -- --write`. Review all coverage,
RMSE, reversal, spike, ordering/unit and append-stability gates; do not advance the
approved fingerprint to hide an unreviewed numeric change.

## Calibration assessment

[calibration.ts](calibration.ts) separates retrospective pace assessment from target
recommendation. Evidence spans 14-42 uninterrupted days with at least three weights,
a current reading and a sufficiently narrow interval. Food affects the target
decision, not the displayed weight interval. Pauses/segment resets restart evidence.
Off-track pace alone does not imply a wrong target. Target-correction recommendations
are limited to adult loss goals and require user acceptance; maintenance/gain still receive an assessment. Goal rate
is a planning target, not a forecast. [calibrationScenarios.ts](calibrationScenarios.ts)
is the deterministic product lab input; client behavior lives in
[Progress](../mobile/src/progress/README.md).
