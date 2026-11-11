import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionRotationControl } from './SessionRotationControl';
import { HoldingPool } from './HoldingPool';

const renderControl = (changes: Partial<Parameters<typeof SessionRotationControl>[0]> = {}) =>
  renderToStaticMarkup(<SessionRotationControl waiting={20} emptyCourts={3} playerCount={4}
    busy={false} preparing={false} closed={false} onReview={() => undefined} {...changes} />);
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('session rotation priority', () => {
  it('shows real waiting/court context with one approved-review action', () => {
    const markup = renderControl();
    expect(text(markup)).toContain('20 waiting 3 empty courts Review rotation');
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('aria-describedby=');
    expect(text(markup)).not.toMatch(/\b(?:AI|demo|sample|saved|effortless)\b/i);
  });
  it.each([{ emptyCourts: 0 }, { waiting: 3 }, { busy: true }, { closed: true }])(
    'guards unavailable review %j', (changes) => {
      expect(renderControl(changes)).toContain('disabled=""');
    });
  it('supports singles without using doubles eligibility', () => {
    expect(renderControl({ playerCount: 2, waiting: 2 })).not.toContain('disabled=""');
    expect(text(renderControl({ emptyCourts: 1 }))).toContain('1 empty court');
  });
  it('keeps loading factual and has no side effect on render', () => {
    const onReview = vi.fn();
    const markup = renderControl({ preparing: true, onReview });
    expect(text(markup)).toContain('Preparing…');
    expect(markup).toContain('disabled=""');
    expect(onReview).not.toHaveBeenCalled();
  });
  it('does not duplicate the relocated control and count inside Waiting', () => {
    const markup = renderToStaticMarkup(<HoldingPool players={[]} onSuggestMatch={() => undefined}
      onReviewRotation={() => undefined} showReviewAction={false} showCount={false} />);
    expect(text(markup)).toContain('Waiting');
    expect(markup).not.toContain('Review rotation');
    expect(markup).not.toContain('count-badge');
    expect(markup).not.toContain('suggest-match-help');
  });
});
