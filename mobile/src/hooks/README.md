# Local-day lifecycle hooks

`useCurrentLocalDate` shares one foreground timer and lifecycle subscription. It
checks minute boundaries and native activation/browser visibility, focus and page
restoration against the current clock in the profile IANA timezone. DST and several
suspended days require no incremental date arithmetic. Subscribers update only when
their local date changes; hidden apps stop the timer, and the final unsubscribe
removes listeners.

Navigation preserves the selected date through forward rollover while refreshing
Today labels, upper bounds, next-day actions and calendar state. Route date parameters
apply once rather than continually replacing manual navigation. `useLocalDayRefresh`
invalidates day-sensitive queries once per date change without clearing form drafts
or queued offline mutations.

Colocated tests cover midnight/resume, timezone and backward-clock changes, DST,
subscription cleanup and retained selection. `e2e/expo-web/local-day-rollover.spec.ts`
checks exported-browser calendar bounds and food/weight draft submission dates.
Native AppState mocks and browser evidence do not establish physical-device behavior.
