---
name: calibrate-progress
description: Explore historical progress and discuss Calibrate health data through the authenticated read-only MCP service and progress explorer. Use when the user asks to see progress, compare periods, understand calorie patterns, explore scale changes or weight trends, assess goal pace, or discuss plateaus recorded in Calibrate.
---

# Explore and Discuss Calibrate Progress

Use the authenticated Calibrate account as the source of truth for logged food, tracking-day status, weight observations, modeled trend, calorie targets, and the current goal. This experience supports exploration and conversation; direct food/weight logging or plan changes to the normal Calibrate app.

## Workflow

1. Call `open_progress_explorer` when the user asks to open or see their progress. It opens historical charts, current goal context, and questions that continue this chat. Its default period is the last 90 user-local days.
2. For a question that does not need another panel, call `get_progress_summary`. Pass paired inclusive `start_date` and `end_date` values for the requested period. Use `compare_progress_periods` with two explicit inclusive periods for comparisons; use the dates and focus sent by the explorer when a question originates there.
3. Every summary/comparison period is limited to 365 days, but all retained history is reachable. For longer requests, use returned history bounds and retrieve adjacent non-overlapping windows of at most 365 days. State actual ranges and coverage; never silently replace a requested historical period with recent data. Combine returned sums and sample counts, not unweighted averages of windows.
4. Retrieve individual food entries with `get_recent_food_logs` (1-31 days, default 14) or detailed weight history with `get_weight_trend` (7-365 days, default 90) only when needed. Both accept historical `end_date`; omitting it preserves the existing recent-period behavior. Do not infer that a detail tool's wider minimum window is the user's exact selected period.
5. Separate observations from interpretation:
   - Food entries and raw weights are observations.
   - Weight trend, confidence intervals, pace, and projection are model estimates.
   - Historical daily targets are saved targets for those dates. Current goal and calorie-plan context describe the actual snapshot date, even when exploring older history.
6. Lead with a concise, evidence-based progress summary. Explain supporting patterns, sample counts, and uncertainty, then offer one or two relevant follow-up questions. Distinguish descriptive associations from causal explanations.

## Food-log interpretation

- Use only days marked `COMPLETE` and `is_representative: true` for intake averages or target-adherence claims.
- Summary averages and meal/weekday patterns already use COMPLETE days. Include their evidence counts when comparing patterns; sparse or unequal coverage limits conclusions.
- Treat `OPEN`, `INCOMPLETE`, `PAUSED`, and pre-tracking days as context. Never describe missing or partial logging as genuine low intake.
- Describe individual entries only when useful to the user's question. Do not moralize foods or label a day "good" or "bad."
- Calibrate food logs contain calories and serving snapshots, not complete macro- or micronutrient data. Do not infer protein, nutrient quality, or deficiencies from names alone.
- Compare historical intake with saved daily targets only. Days with no saved target do not count toward target-adherence denominators. A null result is unavailable evidence, not zero; never backfill historical targets from today's profile or plan.

## Weight-trend interpretation

- Distinguish raw scale readings from the latent trend. Prefer the trend for direction and pace while acknowledging its confidence interval.
- Honor `evidence_status`, `freshness`, and nullable pace. If `weekly_rate` is null, stale, outdated, or based on limited evidence, do not invent or extrapolate a current rate.
- Historical modeled pace describes the selected period end, within the model's bounded horizon. Older raw readings do not imply modeled trend values exist for every chart date. Report first/last observation dates when describing raw change.
- Explain short-term changes cautiously; hydration and normal measurement variability can move scale weight without reflecting tissue change.
- Positive `configured_daily_deficit_kcal` means a weight-loss goal, negative means weight gain, and zero means maintenance.
- The displayed goal is current, not a reconstruction of the goal in an older period. Maintenance has no completion percentage or projection date.
- Never replace or reinterpret `profile_estimated_tdee_kcal` using observed intake and weight. Calibrate's calories-out remains the profile-estimated TDEE.

## Safety and privacy

- Keep discussion informational and supportive, not diagnostic or prescriptive medical care.
- For alarming symptoms, rapid unexplained changes, pregnancy-specific needs, eating-disorder concerns, or medication questions, recommend an appropriate licensed clinician rather than calculating a treatment plan.
- Do not request account IDs, credentials, OAuth tokens, provider identifiers, or barcodes. Authentication is handled by Calibrate's OAuth flow.
- Respect separately granted food and weight access. Explain unavailable sections without requesting unauthorized data or inferring it from another section. All tools are read-only.
- Do not share Calibrate data with another service unless the user separately requests it.
