/** @file ux a11y: Runs only WCAG A/AA axe rules and adds the keyboard-order invariant axe classifies as best practice. */

import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';

const BLOCKING_IMPACTS = new Set(['critical', 'serious']);
const WCAG_A_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

export type SanitizedAccessibilityViolation = {
  rule: string;
  impact: 'critical' | 'serious';
  help: string;
  nodeCount: number;
};

export type AccessibilityScanContext = {
  kind: 'route' | 'overlay' | 'probe';
  surfaceId: string;
};

function isBlockingImpact(impact: string | null): impact is SanitizedAccessibilityViolation['impact'] {
  return impact !== null && BLOCKING_IMPACTS.has(impact);
}

async function countRenderedPositiveTabIndexes(page: Page): Promise<number> {
  return page.locator('[tabindex]').evaluateAll((elements) => elements.filter((element) => {
    const tabindex = Number.parseInt(element.getAttribute('tabindex') ?? '', 10);
    if (!Number.isFinite(tabindex) || tabindex <= 0) return false;
    if (element.closest('[aria-hidden="true"], [hidden]')) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }).length);
}

/** Runs only WCAG A/AA axe rules and adds the keyboard-order invariant axe classifies as best practice. */
export async function collectBlockingAccessibilityViolations(
  page: Page,
): Promise<SanitizedAccessibilityViolation[]> {
  const results = await new AxeBuilder({ page })
    .withTags([...WCAG_A_AA_TAGS])
    .analyze();

  const violations = results.violations
    .filter((violation) => isBlockingImpact(violation.impact))
    .map((violation) => ({
      rule: violation.id,
      impact: violation.impact as SanitizedAccessibilityViolation['impact'],
      help: violation.help,
      nodeCount: violation.nodes.length,
    }));

  const positiveTabIndexCount = await countRenderedPositiveTabIndexes(page);
  if (positiveTabIndexCount > 0) {
    violations.push({
      rule: 'focus-order-positive-tabindex',
      impact: 'serious',
      help: 'Focusable elements must not use a positive tabindex.',
      nodeCount: positiveTabIndexCount,
    });
  }

  return violations.sort((first, second) => first.rule.localeCompare(second.rule));
}

/** Attaches a sanitized accessibility report with surface and viewport identity to the Playwright result. */
export async function attachAccessibilitySummary(
  page: Page,
  testInfo: TestInfo,
  context: AccessibilityScanContext,
  violations: readonly SanitizedAccessibilityViolation[],
): Promise<void> {
  const viewport = page.viewportSize();
  const safeSurfaceId = context.surfaceId.replaceAll(/[^a-z0-9-]/gi, '-').toLowerCase();
  const attachmentName = `accessibility-${safeSurfaceId}.json`;
  const attachmentPath = testInfo.outputPath(attachmentName);
  await writeFile(attachmentPath, JSON.stringify({
    kind: context.kind,
    surfaceId: context.surfaceId,
    project: testInfo.project.name,
    viewport,
    violations,
  }, null, 2));
  await testInfo.attach(attachmentName, {
    path: attachmentPath,
    contentType: 'application/json',
  });
}

/** Waits for fonts, records the accessibility scan, and fails on blocking violations. */
export async function expectNoBlockingAccessibilityViolations(
  page: Page,
  testInfo: TestInfo,
  context: AccessibilityScanContext,
): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const violations = await collectBlockingAccessibilityViolations(page);
  await attachAccessibilitySummary(page, testInfo, context, violations);
  expect(violations, `${context.kind} ${context.surfaceId} has blocking accessibility findings`).toEqual([]);
}
