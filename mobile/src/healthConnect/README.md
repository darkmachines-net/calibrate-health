# Health Connect integration

Calibrate reads activity from Health Connect on the Android phone. Samsung Health remains responsible for moving
Galaxy Watch data into Health Connect; Calibrate does not collect watch sensors directly.

## Product policy

- The integration is read-only: steps, active calories, total calories, exercise sessions, and optional weight.
- Weight is requested only after a separate user opt-in.
- Imported activity is observational. It never changes the profile-based TDEE or calorie target.
- Health Connect aggregate queries are the displayed truth for steps and calories because they apply Health Connect's
  origin-priority rules and avoid inflating totals from overlapping sources.
- Source records are still retained for provenance, exercise details, deletion reconciliation, and account export.
- A manual Calibrate weight remains authoritative for its day; imported weight must not silently replace it.

These choices follow Android's guidance for [aggregated data](https://developer.android.com/health-and-fitness/health-connect/aggregate-data)
and [incremental synchronization](https://developer.android.com/health-and-fitness/health-connect/sync-data).

## Synchronization contract

Changes tokens belong to one Health Connect store, so Calibrate scopes each checkpoint by account, Android installation,
and record type. The phone reads one page, uploads its records, tombstones, aggregate day summaries, and next token in a
single idempotent request, then advances its local checkpoint only after the server acknowledges that transaction.

The server derives source-record `local_date` using the account's IANA timezone at ingestion. Daily aggregates use the
same timezone and explicit date-only keys so spring-forward and fall-back days retain their real 23/25-hour boundaries.
Changing the account timezone does not rewrite historical grouping.

If a token expires or initial history is requested, the phone reconciles a bounded window and creates a new per-type
token. History older than Health Connect's default window and background reading remain explicit later opt-ins; their
permissions are not requested by the initial foreground integration.

## Permissions and failure isolation

The Android manifest declares only the read types exposed in Settings. Connection requests the selected subset, and
weight is off by default. Food and manual weight logging do not depend on Health Connect and continue to work when it is
unsupported, needs an update, has partial/revoked permissions, or a sync is interrupted.

Users can pause reads without revoking access, resume, open Health Connect's Manage access screen, or disconnect. On
Android 14+, a programmatic revoke may not become visible until the app restarts; the UI must explain that behavior.

## Validation

Colocated tests cover normalization, per-scope checkpoints, permission recovery and
account cleanup. Device review should compare Samsung Health arrival delay, overlapping
origins, interrupted/repeated sync, revoke/reconnect, upgrades, battery and network use.
These checks do not authorize a future activity-adjusted calorie policy.
