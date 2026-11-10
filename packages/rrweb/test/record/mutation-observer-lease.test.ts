/**
 * @vitest-environment jsdom
 */
import { afterEach, expect, it } from 'vitest';
import { mutationObserverCtor } from '@grafana/rrweb-utils';

const helperIframeSelector = 'iframe[__rrwebUntaintedMutationObserver]';
const originalUserAgent = Object.getOwnPropertyDescriptor(
  navigator,
  'userAgent',
);

afterEach(() => {
  document.querySelectorAll(helperIframeSelector).forEach((iframe) => {
    iframe.remove();
  });

  if (originalUserAgent) {
    Object.defineProperty(navigator, 'userAgent', originalUserAgent);
  } else {
    delete (navigator as { userAgent?: string }).userAgent;
  }
});

it('keeps the untainted constructor iframe until the last lease is released', () => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Safari',
  });

  const [firstConstructor, releaseFirst] = mutationObserverCtor();
  const [secondConstructor, releaseSecond] = mutationObserverCtor();

  expect(secondConstructor).toBe(firstConstructor);
  expect(document.querySelectorAll(helperIframeSelector)).toHaveLength(1);

  releaseFirst();
  releaseFirst();
  expect(document.querySelectorAll(helperIframeSelector)).toHaveLength(1);

  releaseSecond();
  expect(document.querySelectorAll(helperIframeSelector)).toHaveLength(0);

  const [, releaseAfterInvalidation] = mutationObserverCtor();
  expect(document.querySelectorAll(helperIframeSelector)).toHaveLength(1);
  releaseAfterInvalidation();
  expect(document.querySelectorAll(helperIframeSelector)).toHaveLength(0);
});
