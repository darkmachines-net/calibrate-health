/** @file web Accessibility Styles: Browser system-color overrides keep focus, selection, and progress visible when Windows High Contrast or another forced-colors mode replaces app colors. */

/**
 * Browser system-color overrides keep focus, selection, and progress visible
 * when Windows High Contrast or another forced-colors mode replaces app colors.
 */
export const WEB_ACCESSIBILITY_STYLES = `
@media (forced-colors: active) {
  :focus-visible {
    outline: 3px solid Highlight !important;
    outline-offset: 2px !important;
  }

  [role="radio"][aria-checked="true"],
  [role="tab"][aria-selected="true"],
  [aria-pressed="true"] {
    border-color: Highlight !important;
  }

  [role="progressbar"] {
    forced-color-adjust: none;
    background: Canvas !important;
    border-color: CanvasText !important;
  }

  [role="progressbar"] > [aria-hidden="true"] {
    forced-color-adjust: none;
    background: Highlight !important;
  }
}
`;
