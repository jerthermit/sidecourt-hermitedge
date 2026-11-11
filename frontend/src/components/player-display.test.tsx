import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerDisplay as DisplayState } from '../types/models';
import * as api from '../lib/api';
import { PlayerDisplay, PlayerDisplayContent } from './PlayerDisplay';

const receivedAt = Date.parse('2026-01-15T00:00:00Z');
const players = ['Alex Morgan', 'Blair Chen', 'Casey Rivera', 'Drew Patel'].map((name, index) => ({
  id: `player-${index}`, name,
}));
const display = (overrides: Partial<DisplayState> = {}): DisplayState => ({
  settings: { venueName: 'Garden Club', courtCount: 1, timezone: 'Australia/Sydney', gameMode: 'doubles' },
  session: { id: 'session-one', name: 'Thursday social', startedAt: receivedAt, endedAt: null },
  courts: [{ id: 1, name: 'Garden', status: 'available', players, gameStartedAt: null, timeElapsed: 125 }],
  nextGamePool: { beginner: [], intermediate: [], advanced: [], mixed: [] },
  ...overrides,
});
const render = (state: DisplayState | null, options: { now?: number; error?: string; expired?: boolean } = {}): string =>
  renderToStaticMarkup(<PlayerDisplayContent state={state} lastUpdatedAt={state ? receivedAt : null}
    now={options.now ?? receivedAt} error={options.error ?? null} expired={options.expired ?? false}
    onRetry={() => undefined} />);
const textOf = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const badge = (html: string): string | undefined => html.match(/class="status-badge[^"]*">([^<]*)/u)?.[1];
const timer = (html: string): string | undefined => html.match(/class="court-timer">([^<]*)/u)?.[1];

describe('read-only player screen', () => {
  it('distinguishes empty, partially assigned and complete doubles courts', () => {
    const value = display();
    value.courts[0]!.players = [];
    expect(badge(render(value))).toBe('Open');
    value.courts[0]!.players = players.slice(0, 3);
    expect(badge(render(value))).toBe('Assigned');
    value.courts[0]!.players = players;
    expect(badge(render(value))).toBe('Ready');
  });

  it('shares the court frame, empty net drawing and footer without inviting host actions', () => {
    const value = display();
    const occupied = render(value);
    expect(occupied).toContain('aria-label="Garden" data-ready="true" data-occupied="true"');
    expect(occupied).toContain('class="court-card__roster" aria-label="Garden roster"');
    expect(occupied).toContain('© Emman Ermitaño. All rights reserved.');
    value.courts[0]!.players = [];
    const empty = render(value);
    expect(empty).toContain('class="court-empty__drawing"');
    expect(empty).not.toContain('Drag players');
    value.courts[0]!.status = 'disabled';
    const closed = render(value);
    expect(closed).toContain('aria-label="Court closed"');
    expect(closed).not.toContain('No group assigned');
  });

  it('preserves in-play and closed labels regardless of assigned players', () => {
    const value = display();
    value.courts[0]!.status = 'in-play';
    expect(badge(render(value))).toBe('In play');
    value.courts[0]!.status = 'disabled';
    expect(badge(render(value))).toBe('Closed');
    expect(timer(render(value))).toBeUndefined();
  });

  it('shows two doubles players per team and one singles player per team', () => {
    const value = display();
    const doubles = render(value);
    expect(doubles).toContain('aria-label="Garden team 1"><li>Alex Morgan</li><li>Blair Chen</li>');
    expect(doubles).toContain('aria-label="Garden team 2"><li>Casey Rivera</li><li>Drew Patel</li>');
    value.settings.gameMode = 'singles';
    value.courts[0]!.players = players.slice(0, 1);
    expect(badge(render(value))).toBe('Assigned');
    value.courts[0]!.players = players.slice(0, 2);
    const singles = render(value);
    expect(badge(singles)).toBe('Ready');
    expect(singles).toContain('aria-label="Garden team 1"><li>Alex Morgan</li></ol>');
    expect(singles).toContain('aria-label="Garden team 2"><li>Blair Chen</li></ol>');
  });

  it('advances healthy timers from the confirmed server elapsed time despite clock skew', () => {
    const value = display();
    value.courts[0]!.status = 'in-play';
    value.courts[0]!.gameStartedAt = receivedAt - 3600_000;
    expect(timer(render(value))).toBe('02:05');
    expect(timer(render(value, { now: receivedAt + 5000 }))).toBe('02:10');
    expect(timer(render(value, { now: receivedAt + 7500 }))).toBe('02:12');
    expect(timer(render(value, { now: receivedAt - 5000 }))).toBe('02:05');
  });

  it('freezes stale timers at the last server value and dates the retained snapshot in the venue timezone', () => {
    const value = display();
    value.courts[0]!.status = 'in-play';
    value.courts[0]!.gameStartedAt = receivedAt - 3600_000;
    const options = { error: 'Connection lost. Reconnecting…' };
    const html = render(value, { ...options, now: receivedAt + 600_000 });
    expect(timer(html)).toBe('02:05');
    expect(timer(render(value, { ...options, now: receivedAt + 900_000 }))).toBe('02:05');
    expect(textOf(html)).toContain('Connection lost. Reconnecting… Last updated 11:00:00 (Australia/Sydney).');
    expect(html).toContain(`dateTime="${new Date(receivedAt).toISOString()}"`);
    expect(html).toContain('Alex Morgan');
    expect(html).toContain('>Retry</button>');
    value.settings.timezone = 'Asia/Manila';
    expect(textOf(render(value, options))).toContain('Last updated 08:00:00 (Asia/Manila).');
  });

  it('shows empty and staged next-game groups using names only', () => {
    const value = display();
    expect(textOf(render(value))).toContain('Next game Not yet assigned');
    value.nextGamePool.intermediate = players.slice(0, 2);
    value.nextGamePool.mixed = players.slice(2);
    const html = render(value);
    expect(html).toContain('<h3>intermediate</h3><ol><li>Alex Morgan</li><li>Blair Chen</li></ol>');
    expect(html).toContain('<h3>Open group</h3><ol><li>Casey Rivera</li><li>Drew Patel</li></ol>');
    expect(textOf(html)).not.toContain('Not yet assigned');
  });

  it('places the waiting order below Next game and retains it during a connection failure', () => {
    const value = display({ holdingPool: [
      { id: 'waiting-one', name: 'Morgan Waiting Fullname' },
      { id: 'waiting-two', name: 'Sam Waiting Fullname' },
    ] });
    const html = render(value, { error: 'Connection lost. Reconnecting…', now: receivedAt + 600_000 });
    expect(html.indexOf('aria-label="Next game"')).toBeLessThan(html.indexOf('aria-labelledby="display-waiting-title"'));
    expect(html).toContain('aria-label="Position 1: Morgan Waiting Fullname"');
    expect(html).toContain('aria-label="Position 2: Sam Waiting Fullname"');
    expect(textOf(html)).toContain('Connection lost. Reconnecting… Last updated 11:00:00 (Australia/Sydney).');
    expect(html).not.toMatch(/Move Morgan|Assign group|Stage group|Review rotation|End match/);
  });

  it('removes expired snapshots and retry while retaining recovery for an initial connection failure', () => {
    const expired = render(null, { error: 'Player view expired. Ask the host for a new link.', expired: true });
    expect(textOf(expired)).toContain('Player view expired. Ask the host for a new link.');
    expect(expired).not.toContain('Alex Morgan');
    expect(expired).not.toContain('Retry');
    expect(expired).not.toContain('Last updated');
    const disconnected = render(null, { error: 'Connection lost. Reconnecting…' });
    expect(disconnected).toContain('>Retry</button>');
    expect(disconnected).not.toContain('Last updated');
  });

  it('renders no host controls, ratings, import identifiers or credentials', () => {
    const value = display();
    Object.assign(value.courts[0]!.players[0]!, { skillRating: 3.7, externalId: 'private-member-id', source: 'private-import' });
    const html = render(value);
    expect(textOf(html)).toContain('Thursday social');
    expect(textOf(html)).toContain('Alex Morgan');
    expect(html).not.toMatch(/<button|<select|private-member-id|private-import|3\.7|Add player|End match|Stage group|Operator code/);
    const request = vi.spyOn(api, 'getPlayerDisplay');
    const loading = renderToStaticMarkup(<PlayerDisplay accessKey="private-display-key" />);
    expect(textOf(loading)).toContain('Loading');
    expect(loading).not.toContain('private-display-key');
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });
});
