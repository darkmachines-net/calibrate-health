# Resource API contract

The authored [v1.yaml](v1.yaml) contract produces the TypeScript wire shapes in
[@calibrate/api-client](../../packages/api-client/README.md). Change the schema with
the route/serializer, run `npm run api:generate`, and commit its generated output.
`npm run api:contract:check` detects drift; do not hand-edit generated types.

The stable resource mount is `/api/v1`; `/api` remains the legacy alias without a
scheduled sunset. Native authentication uses `/auth/mobile/*`. Within v1, additions
must remain optional or have an existing unknown-value fallback. Removal, renaming,
new required fields, changed meaning/type, or changed idempotency/conflict semantics
requires a new API version.

`GET /api/v1/client-config` advertises supported APIs, capabilities, release identity,
and minimum native versions. Its response and every startup/server-selection/recheck
request use `no-store`. The runtime version comparison lives in
[releaseCompatibility.ts](../../shared/releaseCompatibility.ts); native floors are
separate from server contract compatibility. See [shared](../../shared/README.md).
