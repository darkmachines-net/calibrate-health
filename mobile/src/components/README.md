# Shared UI primitives

Calibrate uses a near-white page, clear headings, and restrained green emphasis.
The shared tokens own both light and dark palettes and the platform system type scale.

## Grouping and actions

- Use `AppSection` for related information or form fields. It has no surface chrome or implicit action.
- Use `SectionHeader` for a section title, supporting copy, and optional independent action.
- Use `AppActionRow` for a full-width navigation or selection action. Keep independent section headings
  and secondary actions outside the primary target. A single navigation preview may include its own
  label and content in one target, without a duplicate View/Edit link. Rows retain actual 48px geometry,
  keyboard focus, hover, pressed, disabled, and busy states.
- Use `AppNotice` for an important status or decision. Its leading marker and tint identify the notice
  without introducing another floating card. Always include text explaining the state.
- Keep `AppCard` for intentional independent containment, never as the default page wrapper. Inputs,
  selection controls, chart interaction areas, dialogs, and sheets retain their own boundaries.

## Rhythm and emphasis

Design at 320px first. Use 16px phone gutters, 24px wider gutters, 32px between major analytical/form
sections, and 8–12px within groups. Do not retain both card padding and section padding. Screen reading
widths are `overview` (760px), `form` (640px), and `wide` (1040px). Date navigation must use the same
width as its route. Form content and controls reflow at large text sizes. See the `FixedPage`
composition owned by [Today](../today/README.md) and [Progress](../progress/README.md).

Use page/section/body/label/metric typography roles instead of custom font sizes. Metrics use tabular
numerals; prose does not. Ordinary buttons are flat. Filled green indicates the principal action for
the current state: Add food on an open Today, Resume tracking on a paused Today, or Save in an editor.
Do not hide existing direct actions behind menus unless the approved flow specifically calls for it.

### Expansion and return

Food log expands into the shell content below Today's retained date picker. Trend and Plan check
expand into everything below Progress's app bar, above the existing tabs. Preserve the app bar,
desktop rail, tabs, and centered reading width. These are page regions with a pinned heading and
labeled Back action; there is no modal scrim or second navigation bar. Direct detail URLs remain supported.

Measure the source region and available pane. Animate its top and height together with the overview
sections moving past the upper and lower edges: 400ms to expand and 360ms to collapse. Crossfade the
moving source and growing detail together, without a blank interval or scaling text and charts.
On Today, retain one action dock below both overview and expanded content. Add food stays anchored
at the left edge and grows to full width as Complete day slides out to the right, then reverses on
collapse. Keep the same button mounted; do not crossfade or fly in a second dock. At enlarged text
sizes, Add food is already full width: slide the second stacked action right and collapse its vacant
row. Hide that secondary action from interaction and accessibility while expanded, and briefly block
Add food during motion to avoid opening a dialog before focus settles. Moving overview regions clip
at the retained date header, not at their original inner containers.

Reduced motion changes state immediately. Keep detail content scrollable, including at 200% text,
and remeasure the source before collapsing after resize or reflow.

Keep the overview mounted and preserve its scroll position. Hide its controls from interaction and
accessibility while expanded. Focus Back after opening and restore the source's keyboard focus
after closing. Escape and native system Back collapse; nested dialogs handle dismissal first. Browser
Back/Forward traverses the expansion without changing the route URL. Food editing, copy, recipes,
date selection, and Add food, plus Trend controls and Plan check review/apply/undo retain their behavior.

Disabled selection explanations must remain readable; do not fade the entire option row. Busy indicators
must contrast with the actual disabled button surface. Recovery pages must scroll at enlarged text sizes,
and persistent notices must leave navigation reachable and offer dismissal when retry can wait.

Expo Router `Link asChild` merges child styles as objects. Use a flattened style object, with explicit
hover/pressed state if needed, instead of a Pressable style callback that the slot cannot preserve.


## Ownership and verification

Feature composition belongs beside [Today](../today/README.md),
[Progress](../progress/README.md), and [onboarding](../onboarding/README.md).
Shared semantic colors/type/spacing live in `shared/designTokens.ts` and `theme.ts`.
Run component tests and [the UX gates](../../../e2e/expo-web/README.md) after changes.
