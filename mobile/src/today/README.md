# Today composition

- Keep date navigation in one contained, rounded toolbar with separate 48px previous/date/next targets,
  a visible calendar icon at 320px, and a disabled next-day target on Today. Date controls retain date
  selection and provide the secondary Pause tracking action, including its existing confirmation flow.
  Food log, Activity, and Weight use the same unified toolbar, top spacing, and continuous
  `summaryContainer` behind the navbar. Preserve each route's content width and date behavior.
- The open balance region uses the page background: ring left, quiet divider, balance copy right.
  A full-width horizontal rule separates the balance from the weight and Food log content below.
  Do not show the goal number; it remains in Progress's Snapshot. Incomplete, paused, or unavailable
  comparisons retain a neutral ring and the same metric space with status and logged calories, except
  paused days, which use the dedicated pause layout below.
- Historical comparisons identify their source below the balance: **Compared with saved target**
  or **Compared with current target**. Include the same distinction in the accessible description.
  The current-target fallback is display-only; see [daily plan persistence](../../../backend/src/services/README.md#planning-and-daily-comparisons).
- Place the full-width weight control immediately below the balance, above food. It begins with
  **Weigh in** and an inviting supporting label, then becomes a measurement with **Logged today** or
  queued-sync status. Never use "No weigh-in yet" as its principal content. Use the existing scale
  icon and a decorative plus/pencil. Tapping opens the weight sheet over Today with the selected date;
  saving or dismissing stays on Today unless View progress is explicitly requested.
- The food summary is one full-width expansion target that fills the remaining body height,
  including blank space below sparse content. Keep the Food log label, food count, and one expand icon
  above six chronological meal-period rows. Each row shows the whole-meal calorie total or neutral
  **No entries**; zero-calorie foods still count as logged. Use the shared 48px row rhythm without
  individual food names, row actions, omission counts, or height-based fitting. A completely empty
  day shows **No food logged yet** and an invitation to add food. Rows retain intrinsic height and
  scroll inside the food pane on short screens, keeping the date, balance, weight, and action dock
  fixed. Extra height expands the tap target, not the spacing between rows. At enlarged text sizes
  or whenever the measured context, minimum body, and footer cannot fit, scroll the overview
  between the retained date header and action dock. Restore food-only scrolling when they fit again.
  Stack the action buttons only for enlarged text, so the height fallback does not change the
  footer height used to decide whether the fixed layout fits.
- Anchor equal-width **Add food** (filled) and **Complete day** (outlined) controls above the tabs on
  an open day. Add food opens the existing inline search/quantity workflow without navigating away.
  Complete day applies immediately without a confirmation dialog because the action is reversible.
  A completed day retains both positions: Add food is disabled and **Day completed** becomes a dark
  green checked toggle. Tapping it reopens the day and restores the original actions. Incomplete past
  days retain **Edit day**. Keep the paired action heights stable at 320px.
  Paused tracking uses **Resume tracking** in the same action area. Keep incomplete/backfill and error
  recovery available without restoring a separate day-status card.
- Paused days replace the balance and food preview with a spacious pause message and a prominent
  pause symbol. Keep the date toolbar available, with weight entry below the pause message and directly
  above the action dock so the available actions stay together at the bottom. Today's message says
  **Tracking paused** and explains that food logging, targets, and reminders are on pause. Past days
  say **Tracking was paused**, explain that this is not a zero-calorie day, and retain **Edit day** for
  backfill. Weight logging is always available. Retained food entries do not restore the normal
  calorie/meal preview while paused. Let the message scroll on short screens and at enlarged text sizes.


Shared expansion/focus/animation rules belong to [components](../components/README.md).
