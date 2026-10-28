# PR 456 keyboard evidence

Application head: e6ce08cc128916feb88a034b8d7f451c4a8bf26e. Base: dad530511fc9a2149bafe30c7e87194dc285ba6e.

Pixel_10 Android emulator, Chrome 150.0.7871.128, actual Android decimal keyboard, synthetic API fixtures. Captures use adb screencap and DOM-based touch input in Chrome.

Before uses the same rebased application with BottomSheetModal.tsx and KeyboardAwareScrollView.tsx restored to 95c4d87463b899bfe817d7c79e09d5752e995a9e (before the keyboard correction). After uses the final application behavior. The baseline keyboard closes during automatic scrolling. After, it remains open; both input and actions can be scrolled above it. Dismissal retains 0.125 in Add food and 0.250001 in Edit food.

The visible area is about 437 CSS px with the keyboard open, versus 813 px when closed. The sheet follows the browser offset (about 36-46 px) rather than remaining at zero. Geometry is recorded alongside each editor.

Both maintained overlay-viewport regressions fail before the correction (expected top 48, actual 0) and pass after it. All five quantity-entry browser regressions pass, including immediate and blur-before-save precision persistence. All 1,316 mobile tests pass.

This is Android Chrome emulator evidence, not native React Native app, iOS keyboard, physical-device, or live-database verification. Native-device coverage remains deferred. Screenshots are stored on a separate evidence branch, outside the product branch.
