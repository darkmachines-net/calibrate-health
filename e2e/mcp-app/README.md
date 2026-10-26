# MCP App browser tests

These Playwright tests run the actual bundled progress UI in an iframe with a
synthetic MCP Apps host. They require no account, OAuth token, database, or running
Calibrate service. All fixture data and protocol traffic remain in the test page.

## Test boundary

`fixtures.ts` owns deterministic progress snapshots and the minimal `postMessage`
host. It records tool calls, chat messages, context updates, and display-mode
requests. Options simulate permissions, stale/empty evidence, failed reads,
missing messaging, rejected messages, and delayed sends. Period reads filter
chart points but retain fixture aggregates: this harness validates UI behavior,
not server-side aggregation math.

`progress.spec.ts` checks view switching, exact date arguments, comparisons,
explicit chat intent, duplicate-send prevention, focus recovery, escaping,
accessibility, and light/dark narrow layouts. OAuth and account scoping belong
to `backend/test/mcp-http.test.js` and `backend/test/mcp-oauth-integration.test.js`;
aggregation and saved-target semantics belong to `backend/test/mcp-progress-analysis.test.js`.

## Run and maintain

From the repository root:

```sh
npm run setup
npm run test:mcp-app
```

The test command builds the offline App first, then uses
`playwright.mcp-app.config.ts`. Setup installs the host dependencies and Chromium.
Screenshots and failure traces go to ignored `.codex-screenshots/`; do not commit
them as documentation. The affected-input MCP CI lane and `ci:local` run this suite.

Keep the host minimal and deterministic. Add a protocol response only when the
[UI](../../backend/src/mcp/ui/README.md) uses it, record observable behavior, and
avoid copying server calculations into the browser fixtures.
