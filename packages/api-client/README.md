# Calibrate API client

[client.ts](src/client.ts) owns request serialization, cookie/bearer authentication,
refresh handling, cancellation, and typed errors for the Expo clients. [types.ts](src/types.ts)
adapts the generated wire shapes for callers; [index.ts](src/index.ts) is the package entry point.

The [OpenAPI module](../../backend/openapi/README.md) owns wire compatibility and generation.
Keep operation IDs stable across retries. A failed response does not establish that a mutation
was rolled back; callers retain uncertain writes in their account/server outbox.

Run `npm --prefix packages/api-client run typecheck` and
`npm --prefix packages/api-client test` from the repository root after client changes.
