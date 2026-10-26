# Progress explorer UI

This is the browser-only MCP App, separate from the Expo logging client. It shows
one data view at a time: Weight, Intake, or Compare. Weight includes the current
goal; each view offers at most two contextual chat prompts. Preset periods apply
immediately, while custom dates and supporting evidence use disclosures.

## Ownership and boundaries

- `main.ts` owns the MCP Apps SDK connection, view state, disclosures, request
  sequencing, focus restoration, and user-triggered chat messages. Failed reads
  retain the previous snapshot; superseded replies cannot replace newer data.
- `charts.ts` renders SVG observations, model segments and confidence bands,
  and complete/partial food days. Labels adapt to narrow host panels.
- `presentation.ts` escapes interpolated text, formats unavailable values,
  validates inclusive date ranges, and attaches exact periods to chat questions.
- `index.html` and `styles.css` own the offline shell and responsive layout.
  Colors and touch targets come from shared Calibrate tokens and the host theme.

The JSON boundary is [`../progressTypes.ts`](../progressTypes.ts). Data and chat
actions use only the SDK host bridge. The iframe has no credentials, direct API
access, persistent health-data storage, or logging/editing controls. Unsupported
or failed host messaging produces selectable question text for copying into chat.

Keep historical data distinct from the current goal and plan. The parent
[MCP README](../README.md#analysis-boundaries) owns the analysis and OAuth rules;
the UI must preserve those distinctions and nullable evidence in every view.

## Build and verify

From the repository root:

```sh
npm --prefix backend run build:mcp-app
npm --prefix backend run typecheck
npm run test:mcp-app
```

`backend/scripts/build-mcp-app.mjs` inlines code and styles into
`backend/dist/mcp-app/progress.html`. Backend build/test/dev commands prepare the
bundle; Compose Watch rebuilds it when these sources change. The server exposes
it as `ui://calibrate/progress-explorer.html`, without a separate web server.
Close and reopen an existing host panel to load a changed bundle.

The [browser harness](../../../../e2e/mcp-app/README.md) exercises this bundle
without an account. Preserve the compact overview at 320px, keyboard focus,
scope/empty/error states, and the distinction between observations and estimates.
