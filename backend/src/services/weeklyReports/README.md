# Weekly progress reports

An authenticated hourly Cloud Scheduler request fans out bounded Cloud Tasks pages.
Each account is eligible on its own IANA-timezone Sunday after seven elapsed calendar
days since its first weight, food entry, or explicitly completed food day. Food tracking
need not be consistent. The worker rechecks verified account access, current privacy
acceptance on hosted deployments, onboarding, and Firebase revocation before sending data.

`OPENAI_IDENTITY_PROVIDER_ID`, `OPENAI_SERVICE_ACCOUNT_ID`, and `OPENAI_WEEKLY_REPORT_MODEL`
configure the server-only Responses API request. `OPENAI_WIF_AUDIENCE` defaults to
`https://api.openai.com/v1` and must match the OpenAI provider's audience. These settings
contain identifiers, never credentials. Select a model that supports strict JSON-schema
output; no model is selected implicitly. The task queue, origin, caller identity and
OpenAI mapping setup are documented by [GCP](../../../../deploy/gcp/README.md#weekly-progress-reports).
Ordinary page reads never call OpenAI or enqueue work.

The worker requests an OIDC identity token from Google's fixed metadata endpoint for
its attached Cloud Run service account, then exchanges it at
`https://auth.openai.com/oauth/token`. OpenAI verifies the provider and exact service-account
mapping. Tokens stay in process memory and refresh with a one-minute safety margin before
the returned absolute `expires_at`; `expires_in` never extends a delivered token's lifetime.
Concurrent requests share an exchange for the same provider/service-account/audience.
Authentication hops each time out after five seconds, follow no redirects, and expose no
token or provider body in errors. A Responses 401 invalidates the rejected token for the
next task retry. There is no API-key fallback. Local Docker has no Google metadata identity;
use the stubbed tests locally and a configured Cloud Run revision for live verification.

Reports summarize the seven completed days preceding Sunday, with 14/28-day context
when available. Sunday weigh-ins can refresh weight evidence. Missing intake is unknown,
and stale or insufficient weight evidence produces logging guidance rather than an
invented trend. The model sees aggregate coverage, weight changes, goal context, language,
and units; it receives no account ID, email, date of birth, names, or individual food logs.
`store: false` requests no stored response; it does not override OpenAI's API retention
policy. Output is validated, limited to a short summary, up to three highlights, and
one next step. Reports do not write calorie targets or infer replacement TDEE values.

The account/Sunday unique key and an expiring, token-owned database claim prevent
concurrent generation and make retries recoverable. Provider requests time out after
45 seconds including authentication, inside the 60-second API limit. A worker crash releases ownership after
five minutes. Completed reports are immutable; lost provider acknowledgements may incur
another request, but cannot create a second stored report. Queue retries can finish a
report after Sunday. Arbitrary historical/future report requests are ignored. The API
returns the newest 12 reports; account export contains all completed reports and their
aggregate evidence. Account deletion cascades to reports. No provider body or health
evidence is logged on failure.

Run the backend report, provider, task-auth and summary tests with:

```text
node -r ts-node/register --test test/plan-check.test.js test/weekly-report-openai.test.js test/weekly-report-workload-identity.test.js test/weekly-reports.test.js
```

Run this command from `backend`. Tests use synthetic evidence and stubbed providers;
they do not spend API credits or transmit account data.
