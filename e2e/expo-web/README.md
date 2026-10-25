# Exported web validation

UX validation uses one exported Expo web build and one loopback static server per command.
`scripts/ux-gates.mjs` selects `playwright.ux.config.ts`; the shared Playwright wrapper owns the
build/server lifecycle and always tears the server down after the run.

## Commands

Run `npm.cmd run setup` after cloning or whenever `package-lock.json` changes. Repo-owned host setup
uses the installed `@playwright/test` CLI to provision the lock-pinned Chromium revision
idempotently; `ci:local` runs the same setup before reaching the UX diagnostic.

```powershell
npm.cmd run test:ux:a11y
npm.cmd run test:ux:visual
npm.cmd run test:ux
```

- `test:ux:a11y` runs `launch-22-accessibility.spec.ts` at the reviewed 320x568 compact-phone and
  1024x1000 desktop viewports.
- `test:ux:visual` runs `launch-22-visual.spec.ts` at 320x568, 390x844, 820x1180,
  1024x1000, and 1440x1000.
- `test:ux` runs both files in one Playwright invocation, so it does not rebuild or restart the
  static export between semantic and visual checks.
- `ci:local` runs the combined semantic and visual diagnostic on Windows. On macOS and Linux it runs
  the semantic check only, because reviewed Windows pixel baselines are intentionally OS-specific.

The UX config freezes locale, timezone, clock, generated values, animation, viewport, and browser.
Accessibility results reject critical and serious axe findings. Visual comparison uses reviewed
Windows Chromium baselines and a maximum 0.2 percent changed-pixel ratio. Normal validation never
passes Playwright's snapshot-update flag.

## Reviewing snapshot changes

Snapshot changes require an explicit review action from a Windows host using the pinned Playwright
Chromium revision:

```powershell
$env:CALIBRATE_APPROVE_UX_SNAPSHOTS='1'
npm.cmd run test:ux:update-snapshots
Remove-Item Env:CALIBRATE_APPROVE_UX_SNAPSHOTS
```

The update command refuses every value except the exact string `1`. Review the complete changed
images, confirm the intended route, fixture state, viewport, theme, and text scale, then run
`npm.cmd run test:ux` again without the approval variable. Do not accept snapshots to hide an
unexplained layout, focus, contrast, clipping, or stale-state regression.

## Optional GitHub Actions run

Pull requests and **Release** do not run the full UX suite automatically. When a visual or
interaction change warrants the cost, manually dispatch **Builds** with the `web` or
`web-and-native` validation scope. That dispatch runs the full exported-Web, data-state,
accessibility, and visual suites on the repository-pinned Playwright browser.

The manually dispatched UX job uploads `.codex-screenshots/expo-web-ux-results` even when the run
fails and retains the diagnostic for seven days. The directory contains deterministic fixture
screenshots/traces plus bounded accessibility attachments. Accessibility JSON includes only the
fixed surface, rule, impact, help, node count, project, and viewport fields. It must not include
URLs, selectors, HTML, visible text, form values, request data, or raw axe results. The artifact is
for investigation; it is not retained release evidence.

Intentional unnamed-control, contrast, focus-order, and spacing probes inject temporary defects and
pass only when the underlying detector rejects those defects. Probe output is diagnostic only;
never commit a deliberately failing production state.

## Manual assistive-technology review

Run this checklist against a release build with a populated deterministic account. Record the browser, screen-reader version, verbosity settings, result, and any deviation from the expected announcement.

1. Sign-in and route focus
   - Open Sign in and confirm the `calibrate` heading is announced once.
   - Traverse Email, Password, Forgot password, Sign in, Create an account, and trust links.
   - Submit an invalid password and confirm the error is announced without exposing request or server details.
   - Activate `Skip to main content` and confirm focus moves to the main landmark.

2. Today food and weight
   - On Today, confirm the route heading receives focus after navigation.
   - Open Add food from the keyboard and confirm `Add food` is announced as a modal dialog.
   - Confirm `Add food method` is announced as a named radio group and arrow keys change its selected option.
   - Close the dialog and confirm focus returns to Add food.
   - Open Weight entry, close it, and confirm focus returns to the Today weight control.

3. Progress and Trend
   - Confirm `Goal progress` is announced as a progress indicator with its current value.
   - Open Trend and confirm the chart is announced once as a named image; axis labels and SVG descendants must not create a second reading sequence.
   - On `Select nearest weigh-in`, use Left, Right, Home, and End and confirm each selected date/value update is announced.
   - Confirm Previous and Next weigh-in controls expose their disabled state at range boundaries and keep the selected point summary in sync.

4. Settings and dialogs
   - Open Settings > Preferences and confirm the page heading and Tracking preferences section are announced.
   - Confirm `Weight unit` and `Height unit` are named radio groups. Arrow keys should select and focus one option while Tab leaves the group as one stop.
   - In an actual modal such as Add food, confirm background app content is absent from the virtual cursor until it closes.
   - Save preferences or navigate back and confirm the Settings page regains focus.

5. Reflow and high contrast
   - At 200% text, repeat Trend chart navigation and Preferences checks without horizontal page scrolling or clipped labels/actions.
   - In Windows High Contrast, confirm keyboard focus, selected radios, and progress tracks/fills remain distinguishable without relying on app colors alone.

## Evidence and broader coverage

Normal browser suites use deterministic API fixtures; they do not prove deployed
backend or physical-device behavior. `npm run test:web:e2e` builds once and serves
the export locally. Installed Chrome can be selected with `PLAYWRIGHT_CHROME_CHANNEL`
or `PLAYWRIGHT_CHROME_PATH`; UX uses the pinned Chromium baseline instead.
Opt-in captures go under `.codex-screenshots/`, not tracked documentation.
Reviewed Playwright golden images stay beside the tests that consume them.

Set `CALIBRATE_DESIGN_REVIEW_DIR=.codex-screenshots/design-review` and run
`npm run test:web:e2e -- e2e/expo-web/design-review.spec.ts` for the route/overlay atlas.
It waits for theme hydration and captures compact/phone/tablet/desktop views in both
themes. It does not replace semantic or visual regression checks. Native software
keyboard, cutout/inset, permission and screen-reader behavior needs native evidence.
