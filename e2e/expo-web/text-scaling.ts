/** @file text scaling: Keeps text enlargement active when responsive layouts mount new content. */

import type { Page } from '@playwright/test';

/** Keeps text enlargement active when responsive layouts mount new content. */
export async function applyTwoHundredPercentText(page: Page) {
  await page.evaluate(() => {
    const rule = document.createElement('style');
    rule.textContent = '[data-ux-large-text] { font-size: calc(var(--ux-base-font-size) * 2) !important; line-height: calc(var(--ux-base-line-height) * 2) !important; }';
    document.head.append(rule);
    function scale(element: Element) {
      if (element.hasAttribute('data-ux-large-text')) return;
      const isTextInput = element.matches('input:not([type=checkbox]):not([type=radio]), textarea');
      if (!isTextInput && !Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()))) return;
      const computed = getComputedStyle(element);
      const fontSize = Number.parseFloat(computed.fontSize);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      if (!Number.isFinite(fontSize)) return;
      const styled = element as HTMLElement | SVGElement;
      styled.style.setProperty('--ux-base-font-size', `${fontSize}px`);
      styled.style.setProperty('--ux-base-line-height', `${Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.5}px`);
      element.setAttribute('data-ux-large-text', 'true');
    }
    function scan(root: Element) {
      scale(root);
      root.querySelectorAll('*').forEach(scale);
    }
    scan(document.body);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData' && record.target.parentElement) scale(record.target.parentElement);
        record.addedNodes.forEach(node => {
          if (node instanceof Element) scan(node);
          else if (node.parentElement) scale(node.parentElement);
        });
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}
