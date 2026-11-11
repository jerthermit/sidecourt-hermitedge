import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListPagination } from './ListPagination';
import { PlayerDisplayContent, PlayerWaitingList } from './PlayerDisplay';
import type { PlayerDisplay as DisplayState } from '../types/models';

const hooks = vi.hoisted(() => ({ state: vi.fn(), externalStore: vi.fn(), reduced: true }));
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  hooks.state.mockImplementation(react.useState);
  return { ...react, useState: hooks.state, useSyncExternalStore: hooks.externalStore };
});
vi.mock('../lib/interactionMotion', () => ({
  useMotionPolicy: () => ({ layout: false, reduced: hooks.reduced, dragging: false, transition: { duration: 0 } }),
  interactionEase: [0.22, 0.75, 0.2, 1],
}));

const players = Array.from({ length: 32 }, (_, index) => ({
  id: `waiting-${index + 1}`, name: `Waiting Player ${String(index + 1).padStart(2, '0')}${index === 26 ? ' Santos de la Cruz' : ''}`,
}));
const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...Children.toArray(node.props.children as ReactNode).flatMap(elements)];
}
function renderWaiting({ width = 1200, search = '', page = 1, pageSize = null, waiting = players }: {
  width?: number; search?: string; page?: number; pageSize?: number | null; waiting?: typeof players;
} = {}) {
  vi.stubGlobal('window', { matchMedia: (query: string) => ({
    matches: width <= 600 || (query.includes('min-width: 1440px') && width >= 1440),
  }) });
  const setSearch = vi.fn();
  const setPage = vi.fn();
  const setPageSize = vi.fn();
  hooks.state.mockImplementationOnce(() => [search, setSearch])
    .mockImplementationOnce(() => [page, setPage])
    .mockImplementationOnce(() => [pageSize, setPageSize]);
  hooks.externalStore.mockImplementationOnce((_subscribe, read) => read());
  const tree = PlayerWaitingList({ players: waiting });
  vi.stubGlobal('window', undefined);
  return { tree, html: renderToStaticMarkup(tree), setSearch, setPage, setPageSize };
}
const rows = (html: string) => [...html.matchAll(/<li value="(\d+)" aria-label="([^"]*)"/g)]
  .map((match) => ({ position: Number(match[1]), label: match[2] }));

beforeEach(() => {
  hooks.reduced = true;
  hooks.state.mockClear();
  hooks.externalStore.mockReset().mockImplementation((_subscribe, _read, serverRead) => serverRead());
});

describe('mobile waiting shortcut', () => {
  const state: DisplayState = {
    settings: { venueName: 'Sidecourt', courtCount: 12, timezone: 'Asia/Manila', gameMode: 'doubles' },
    session: { id: 'session-one', name: 'Club session', startedAt: 1, endedAt: null },
    courts: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, status: 'available',
      players: [], gameStartedAt: null, timeElapsed: 0 })),
    nextGamePool: { beginner: [], intermediate: [], advanced: [], mixed: [] },
    holdingPool: players,
  };
  const displayTree = (value = state) => PlayerDisplayContent({ state: value, lastUpdatedAt: 1,
    now: 1, error: null, expired: false, onRetry: () => undefined });
  const shortcut = (tree: ReactNode) => elements(tree).find((element) => element.type === 'button'
    && String(element.props.className).includes('display-waiting-jump'));

  it.each([{ reduced: true, behavior: 'auto' }, { reduced: false, behavior: 'smooth' }])(
    'scrolls and focuses search with $behavior behavior while preserving display credentials', ({ reduced, behavior }) => {
      hooks.reduced = reduced;
      const tree = displayTree();
      const button = shortcut(tree)!;
      expect(button.props.type).toBe('button');
      expect(button.props['aria-controls']).toBe('display-waiting');
      expect(button.props.children).toBe('Waiting');
      expect(button.props).not.toHaveProperty('href');
      const search = { focus: vi.fn() };
      const waiting = { scrollIntoView: vi.fn(), querySelector: vi.fn(() => search) };
      const getElementById = vi.fn(() => waiting);
      const setHash = vi.fn();
      const location = {};
      Object.defineProperty(location, 'hash', { get: () => '#display=private-screen-key', set: setHash });
      vi.stubGlobal('document', { getElementById });
      vi.stubGlobal('window', { location });

      (button.props.onClick as () => void)();

      expect(getElementById).toHaveBeenCalledWith('display-waiting');
      expect(waiting.scrollIntoView).toHaveBeenCalledWith({ behavior, block: 'start' });
      expect(waiting.querySelector).toHaveBeenCalledWith('input[type="search"]');
      expect(search.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(window.location.hash).toBe('#display=private-screen-key');
      expect(setHash).not.toHaveBeenCalled();
    },
  );

  it('omits the shortcut when no one is waiting', () => {
    expect(shortcut(displayTree({ ...state, holdingPool: [] }))).toBeUndefined();
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('bounded player waiting order', () => {
  it.each([{ width: 390, size: 6 }, { width: 1200, size: 12 }, { width: 1600, size: 6 }])(
    'uses $size rows at $width pixels while exposing all 32 through the existing pagination', ({ width, size }) => {
      const { html } = renderWaiting({ width });
      expect(rows(html).map((row) => row.position)).toEqual(Array.from({ length: size }, (_, index) => index + 1));
      expect(html).toContain(`aria-label="Waiting: 1 to ${size} of 32"`);
      expect(html).toContain('aria-label="Next Waiting page"');
      expect(html).toContain('Search waiting players</span><input type="search"');
      expect(html).not.toContain('Waiting Player 32');
    },
  );

  it('keeps global positions on later pages, and permits a bounded page-size choice', () => {
    const { html } = renderWaiting({ page: 3, pageSize: 12 });
    expect(rows(html).map((row) => row.position)).toEqual([25, 26, 27, 28, 29, 30, 31, 32]);
    expect(html).toContain('aria-label="Waiting: 25 to 32 of 32"');
    expect(html).toContain('Waiting Player 27 Santos de la Cruz');
    expect(html).not.toContain('Waiting Player 24');
    const expanded = renderWaiting({ pageSize: 24 });
    expect(rows(expanded.html)).toHaveLength(24);
    expect(expanded.html).not.toContain('Waiting Player 25');
  });

  it('finds a full name case-insensitively without changing its position into filtered rank', () => {
    const { html } = renderWaiting({ search: '  waiting PLAYER 27 santos de la cruz  ' });
    expect(rows(html)).toEqual([{ position: 27, label: 'Position 27: Waiting Player 27 Santos de la Cruz' }]);
    expect(html).toContain('aria-label="Waiting: 1 to 1 of 1"');
    expect(html).not.toContain('Position 1:');
    expect(html).not.toContain('aria-label="Next Waiting page"');
  });

  it('resets browsing to page one when the search or page size changes', () => {
    const view = renderWaiting({ page: 2 });
    const input = elements(view.tree).find((element) => element.type === 'input')!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'Santos' } });
    expect(view.setSearch).toHaveBeenCalledWith('Santos');
    expect(view.setPage).toHaveBeenCalledWith(1);
    const pagination = elements(view.tree).find((element) => element.type === ListPagination)!;
    (pagination.props.onPageSizeChange as (size: number) => void)(6);
    expect(view.setPageSize).toHaveBeenCalledWith(6);
    expect(view.setPage).toHaveBeenLastCalledWith(1);
    (pagination.props.onPageChange as (page: number) => void)(3);
    expect(view.setPage).toHaveBeenLastCalledWith(3);
  });

  it('clamps a removed final page and distinguishes an empty queue from no search matches', () => {
    const shortened = renderWaiting({ page: 3, pageSize: 12, waiting: players.slice(0, 24) });
    expect(shortened.setPage).toHaveBeenCalledWith(2);
    expect(rows(shortened.html).map((row) => row.position)).toEqual(Array.from({ length: 12 }, (_, index) => index + 13));
    const noMatches = renderWaiting({ search: 'No such full name', page: 3 });
    expect(rows(noMatches.html)).toEqual([]);
    expect(textOf(noMatches.html)).toContain('No matching players');
    expect(noMatches.setPage).toHaveBeenCalledWith(1);
    const empty = renderWaiting({ waiting: [] });
    expect(textOf(empty.html)).toBe('Waiting No players waiting');
    expect(empty.html).not.toMatch(/<input|<select|<button|Waiting pages/);
  });

  it('renders only full names and positions, without profile, drag or host controls', () => {
    const privatePlayer = { id: 'private-waiting-id', name: 'Full Name Santos de la Cruz',
      externalId: 'private-import-identity', source: 'private-import-source', skillRating: 4.25,
      playStyle: 'Attacking', attendance: 'ready', gamesPlayed: 19 };
    const { html } = renderWaiting({ waiting: [privatePlayer] });
    expect(textOf(html)).toContain('1 Full Name Santos de la Cruz');
    expect(html).toContain('aria-label="Position 1: Full Name Santos de la Cruz"');
    expect(html).not.toMatch(/private-waiting-id|private-import|4\.25|Attacking|gamesPlayed|draggable|role="button"|Move |Stage |Rest |Leave|Assign|estimated|minutes/i);
    expect(html).not.toContain('class="player-card');
  });
});
