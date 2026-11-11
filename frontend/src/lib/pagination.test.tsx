import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { pageWindow } from './pagination';
import { HoldingPool } from '../components/HoldingPool';
import { ListPagination } from '../components/ListPagination';
import type { Player } from '../types/models';

describe('list page boundaries', () => {
  it.each([
    [0, 9, 12, { page: 1, pageCount: 1, start: 0, end: 0 }],
    [25, 2, 12, { page: 2, pageCount: 3, start: 12, end: 24 }],
    [25, 99, 12, { page: 3, pageCount: 3, start: 24, end: 25 }],
    [500, 42, 12, { page: 42, pageCount: 42, start: 492, end: 500 }],
    [24, -1, 12, { page: 1, pageCount: 2, start: 0, end: 12 }],
    [13, NaN, NaN, { page: 1, pageCount: 2, start: 0, end: 12 }],
  ])('clamps count %s, page %s, size %s', (total, page, size, expected) => {
    expect(pageWindow(total as number, page as number, size as number)).toEqual(expected);
  });

  it('visits every identity once without reordering or mutating the source', () => {
    for (const total of [0, 1, 12, 13, 25, 200, 500]) {
      const source = Array.from({ length: total }, (_, index) => index);
      for (const size of [6, 12, 24, 48]) {
        const all: number[] = [];
        for (let page = 1; page <= pageWindow(total, 1, size).pageCount; page++) {
          const { start, end } = pageWindow(total, page, size);
          const slice = source.slice(start, end);
          expect(slice.length).toBeLessThanOrEqual(size);
          all.push(...slice);
        }
        expect(all).toEqual(source);
      }
    }
  });

  it('keeps page navigation bounded, named and locked during dragging', () => {
    const html = renderToStaticMarkup(<ListPagination label="Waiting" {...pageWindow(25, 2, 12)}
      total={25} pageSize={12} disabled onPageChange={() => undefined} onPageSizeChange={() => undefined} />);
    expect(html).toContain('Waiting: 13 to 24 of 25');
    expect(html).toContain('aria-label="Previous Waiting page" disabled=""');
    expect(html).toContain('aria-label="Next Waiting page" disabled=""');
    expect(html).toContain('Waiting per page');
  });
});

describe('bounded waiting rendering', () => {
  const players: Player[] = Array.from({ length: 500 }, (_, index) => ({ id: `p-${index}`,
    name: `Waiting member ${index + 1}`, skillLevel: 'unrated', skillRating: null, playStyle: 'Balanced',
    attendance: 'ready', source: null, externalId: null, location: { type: 'holding-pool', index }, createdAt: 1 }));

  it('renders twelve of 500 without reducing the session count or planner eligibility', () => {
    const html = renderToStaticMarkup(<HoldingPool players={players} onSuggestMatch={() => undefined}
      onReviewRotation={() => undefined} />);
    expect(html.match(/aria-label="Queue position /g)).toHaveLength(12);
    expect(html).toContain('title="Waiting member 12"');
    expect(html).not.toContain('title="Waiting member 13"');
    expect(html).toContain('Waiting: 1 to 12 of 500');
    expect(html).toContain('aria-label="500 players waiting"');
    expect(html).toMatch(/<button[^>]*aria-describedby="suggest-match-help"[^>]*>Review rotation<\/button>/);
    expect(players).toHaveLength(500);
  });

  it('locks view controls during a drag but keeps the complete queue drop target', () => {
    const html = renderToStaticMarkup(<HoldingPool players={players} paginationLocked onSuggestMatch={() => undefined} />);
    expect(html).toContain('aria-label="Check-in queue drop area"');
    expect(html).toMatch(/<input[^>]*type="search"[^>]*disabled=""/);
    expect(html).toContain('aria-label="Next Waiting page" disabled=""');
  });
});
