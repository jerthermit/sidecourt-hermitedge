import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { pageWindow } from '../lib/pagination';
import type { Court, Player } from '../types/models';
import { Roster } from './Roster';

const player = (index: number): Player => ({
  id: `player-${index}`, name: `Player ${index}`, skillLevel: 'intermediate', skillRating: 3.4,
  playStyle: 'Balanced', attendance: 'ready', source: 'Members', externalId: `member-${index}`,
  location: { type: 'holding-pool', index }, createdAt: index, gamesPlayed: index,
});
const players = Array.from({ length: 31 }, (_, index) => player(index + 1));
const activeCourt: Court = {
  id: 1, name: 'Garden', status: 'in-play', players: [players[0], players[30]],
  gameStartedAt: 1, timeElapsed: 0,
};
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const buttonFor = (markup: string, label: string): string => {
  const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((candidate) => candidate.includes(`aria-label="${label}"`));
  expect(button, `Expected a ${label} control`).toBeDefined();
  return button!;
};

describe('bounded roster pages', () => {
  it('renders twelve identified rows while retaining whole-roster attendance and court totals', () => {
    const html = renderToStaticMarkup(<Roster players={players} courts={[activeCourt]} disabled={false}
      onImport={() => undefined} onAttendance={async () => true} />);
    const body = html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? '';

    expect(body.match(/<tr\b/g)).toHaveLength(12);
    expect(body).toContain('member-1 / Members');
    expect(body).toContain('member-12 / Members');
    expect(body).not.toContain('member-13 / Members');
    expect(textOf(html)).toContain('All 31');
    expect(textOf(html)).toContain('Ready 29');
    expect(textOf(html)).toContain('Playing 2');
    expect(textOf(html)).not.toContain('on court');
    expect(html).toContain('Roster per page</span><select');
    expect(buttonFor(html, 'Previous Roster page')).toContain('disabled=""');
    expect(buttonFor(html, 'Next Roster page')).not.toContain('disabled=""');
    expect(html).not.toContain('Remove Player 1 from roster');
  });

  it('keeps native row actions and active-player removal guards on a large roster', () => {
    const remove = vi.fn(async () => true);
    const html = renderToStaticMarkup(<Roster players={players} courts={[activeCourt]} disabled={false}
      onImport={() => undefined} onAttendance={async () => true} onRemove={remove} />);

    expect(html.match(/<details class="roster-more">/g)).toHaveLength(12);
    expect(buttonFor(html, 'Rest Player 1')).toContain('disabled=""');
    expect(buttonFor(html, 'Mark Player 1 as left')).toContain('disabled=""');
    expect(buttonFor(html, 'Remove Player 1 from roster')).toContain('disabled=""');
    expect(buttonFor(html, 'Remove Player 2 from roster')).not.toContain('disabled=""');
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps closed-session browsing available and only locks it during pending work', () => {
    const render = (paginationLocked = false) => renderToStaticMarkup(<Roster players={players} courts={[]}
      disabled paginationLocked={paginationLocked} onImport={() => undefined}
      onAttendance={async () => true} onRemove={async () => true} />);
    const closed = render();
    expect(buttonFor(closed, 'Next Roster page')).not.toContain('disabled=""');
    expect(closed.match(/<input[^>]*type="search"[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(closed.match(/<button[^>]*aria-pressed="true"[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(buttonFor(closed, 'Remove Player 2 from roster')).toContain('disabled=""');

    const pending = render(true);
    expect(buttonFor(pending, 'Next Roster page')).toContain('disabled=""');
    expect(pending.match(/<input[^>]*type="search"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(pending.match(/<button[^>]*aria-pressed="true"[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it('clamps a final page after removal and keeps an empty roster on page one', () => {
    expect(pageWindow(25, 3, 12)).toEqual({ page: 3, pageCount: 3, start: 24, end: 25 });
    expect(pageWindow(24, 3, 12)).toEqual({ page: 2, pageCount: 2, start: 12, end: 24 });
    expect(pageWindow(0, 2, 12)).toEqual({ page: 1, pageCount: 1, start: 0, end: 0 });
  });
});
