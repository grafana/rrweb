import { describe, it, expect } from 'vitest';
import { shouldUseCompactStyleDiff } from '../../src/record/mutation';

describe('shouldUseCompactStyleDiff', () => {
  it('uses compact diff when no var() is involved', () => {
    expect(
      shouldUseCompactStyleDiff(
        { color: 'red' },
        { display: ['block', ''] },
        'color: red; display: block',
      ),
    ).toBe(true);
  });

  it('uses compact diff when var() is in a longhand and fully captured', () => {
    expect(
      shouldUseCompactStyleDiff(
        { color: 'var(--text-color)' },
        { display: ['block', ''] },
        'color:var(--text-color);display:block',
      ),
    ).toBe(true);
  });

  it('falls back to full string when var() count mismatches', () => {
    // var() in shorthand expanded to empty longhands — count mismatch
    expect(
      shouldUseCompactStyleDiff(
        {
          'border-top-width': false,
          'border-top-style': false,
          'border-top-color': false,
          'border-right-width': false,
          'border-right-style': false,
          'border-right-color': false,
          'border-bottom-width': false,
          'border-bottom-style': false,
          'border-bottom-color': false,
          'border-left-width': false,
          'border-left-style': false,
          'border-left-color': false,
        },
        {},
        'border: 1px solid var(--border-color)',
      ),
    ).toBe(false);
  });

  it('falls back when shorthand var() expands to empty longhands alongside captured longhands', () => {
    // border shorthand expanded to empty longhands, but color captured as longhand
    // var() count: diff has 1 (from color), style has 2 — mismatch
    expect(
      shouldUseCompactStyleDiff(
        {
          color: 'var(--text)',
          'margin-top': false,
          'margin-right': false,
          'margin-bottom': false,
          'margin-left': false,
        },
        {},
        'color: var(--text); margin: var(--m)',
      ),
    ).toBe(false);
  });

  it('falls back when var() counts match but empty longhands are present', () => {
    // Browser lists shorthand "border" AND its longhands: shorthand captures
    // var() so counts match, but empty longhands would still corrupt replay
    expect(
      shouldUseCompactStyleDiff(
        {
          border: '1px solid var(--c)',
          'border-top-width': '',
          'border-top-style': '',
          'border-top-color': '',
        },
        {},
        'border: 1px solid var(--c)',
      ),
    ).toBe(false);
  });

  it('falls back when multiple shorthand var() expand to empty longhands', () => {
    expect(
      shouldUseCompactStyleDiff(
        {
          'margin-top': false,
          'margin-right': false,
          'margin-bottom': false,
          'margin-left': false,
          'padding-top': false,
          'padding-right': false,
          'padding-bottom': false,
          'padding-left': false,
        },
        {},
        'margin: var(--m); padding: var(--p)',
      ),
    ).toBe(false);
  });

  it('falls back for nested var() in shorthand', () => {
    expect(
      shouldUseCompactStyleDiff(
        {
          'margin-top': false,
          'margin-right': false,
          'margin-bottom': false,
          'margin-left': false,
        },
        {},
        'margin: var(--m, var(--fallback))',
      ),
    ).toBe(false);
  });

  it('allows empty custom properties when var() is present', () => {
    // Custom properties (--*) can legitimately be empty, don't flag them
    expect(
      shouldUseCompactStyleDiff(
        { '--my-var': '' },
        { color: ['var(--my-var)', ''], display: ['block', ''] },
        '--my-var: ; color: var(--my-var); display: block',
      ),
    ).toBe(true);
  });

  it('falls back when diff is longer than style string', () => {
    expect(
      shouldUseCompactStyleDiff(
        {
          'margin-top': '10px',
          'margin-right': '10px',
          'margin-bottom': '10px',
          'margin-left': '10px',
        },
        {},
        'margin: 10px',
      ),
    ).toBe(false);
  });

  it('falls back when shorthand with var() is partially overridden', () => {
    // padding: var(--p) sets all longhands to pending-substitution,
    // then padding-top: 10px overrides just one
    expect(
      shouldUseCompactStyleDiff(
        {
          'padding-top': '10px',
          'padding-right': '',
          'padding-bottom': '',
          'padding-left': '',
        },
        {},
        'padding: var(--p); padding-top: 10px',
      ),
    ).toBe(false);
  });

  it('uses compact diff for property deletions with no var()', () => {
    expect(
      shouldUseCompactStyleDiff(
        { margin: false },
        { color: ['red', ''], display: ['block', ''] },
        'color: red; display: block',
      ),
    ).toBe(true);
  });

  it('falls back for var() in background shorthand', () => {
    expect(
      shouldUseCompactStyleDiff(
        {
          'background-image': false,
          'background-position-x': false,
          'background-position-y': false,
          'background-size': false,
          'background-repeat': false,
          'background-attachment': false,
          'background-origin': false,
          'background-clip': false,
          'background-color': false,
        },
        {},
        'background: var(--bg)',
      ),
    ).toBe(false);
  });

  it('handles unchanged styles with var() alongside corrupted diff', () => {
    // color unchanged with var(), margin shorthand expanded to empty longhands
    expect(
      shouldUseCompactStyleDiff(
        {
          'margin-top': false,
          'margin-right': false,
          'margin-bottom': false,
          'margin-left': false,
        },
        { color: ['var(--c)', ''] },
        'color: var(--c); margin: var(--m)',
      ),
    ).toBe(false);
  });
});
