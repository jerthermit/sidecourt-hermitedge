import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Court, Player } from '../types/models';
import { RemovePlayerDialog } from './RemovePlayerDialog';
import { Roster } from './Roster';

const player = (overrides: Partial<Player> = {}): Player => ({
  id: 'player-1', name: 'Alex Morgan', skillLevel: 'intermediate', skillRating: 3.4,
  playStyle: 'Balanced', attendance: 'ready', source: null, externalId: null,
  location: { type: 'holding-pool', index: 0 }, createdAt: 1, gamesPlayed: 2, ...overrides,
});
const court = (players: Player[] = [], status: Court['status'] = 'available'): Court => ({
  id: 1, name: 'Garden', status, players, gameStartedAt: status === 'in-play' ? 1 : null, timeElapsed: 0,
});
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const buttonFor = (markup: string, label: string): string => {
  const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((candidate) => textOf(candidate) === label || candidate.includes(`aria-label="${label}"`));
  expect(button, `Expected a ${label} control`).toBeDefined();
  return button!;
};
const renderRoster = (overrides: { players?: Player[]; courts?: Court[]; disabled?: boolean;
  onRemove?: (id: string) => Promise<boolean> } = {}): string => renderToStaticMarkup(<Roster
    players={overrides.players ?? [player()]} courts={overrides.courts ?? []}
    disabled={overrides.disabled ?? false} onImport={() => undefined} onAttendance={async () => true}
    onRemove={overrides.onRemove} />);

describe('roster player removal', () => {
  it('keeps legacy callers valid and does not expose removal without a handler', () => {
    const html = renderRoster();
    expect(html).not.toContain('Remove Alex Morgan from roster');
    expect(textOf(html)).toContain('Rest');
    expect(textOf(html)).toContain('Leave');
  });

  it('keeps the primary attendance action visible and places secondary actions under More', () => {
    const html = renderRoster({ onRemove: async () => true });
    expect(buttonFor(html, 'Rest Alex Morgan')).not.toContain('disabled=""');
    expect(html).toContain('<details class="roster-more">');
    expect(html).toContain('aria-label="More actions for Alex Morgan"');
    expect(buttonFor(html, 'Mark Alex Morgan as left')).not.toContain('disabled=""');
    expect(buttonFor(html, 'Remove Alex Morgan from roster')).not.toContain('disabled=""');
    expect(html.match(/<details class="roster-more">/g)).toHaveLength(1);
  });

  it('blocks attendance and removal actions while the player is in an active match', () => {
    const active = player({ location: { type: 'court', courtId: 1 } });
    const html = renderRoster({ players: [active], courts: [court([active], 'in-play')], onRemove: async () => true });
    expect(buttonFor(html, 'Rest Alex Morgan')).toContain('disabled=""');
    expect(buttonFor(html, 'Mark Alex Morgan as left')).toContain('disabled=""');
    expect(buttonFor(html, 'Remove Alex Morgan from roster')).toContain('disabled=""');
    expect(buttonFor(html, 'Remove Alex Morgan from roster')).toContain('title="End the match first"');
  });

  it('guards every row action when the session is unavailable or saving', () => {
    const html = renderRoster({ disabled: true, onRemove: async () => true });
    expect(buttonFor(html, 'Rest Alex Morgan')).toContain('disabled=""');
    expect(html).toContain('aria-label="More actions for Alex Morgan" aria-disabled="true"');
    expect(buttonFor(html, 'Mark Alex Morgan as left')).toContain('disabled=""');
    expect(buttonFor(html, 'Remove Alex Morgan from roster')).toContain('disabled=""');
  });

  it('names the player, preserves recorded history, requires no reason and keeps errors actionable', () => {
    const remove = vi.fn(async () => false);
    const html = renderToStaticMarkup(<RemovePlayerDialog player={player()} busy={false}
      error="Player state changed. Try again." onRemove={remove} onClose={() => undefined} />);
    expect(textOf(html)).toMatch(/Remove player.*Alex Morgan/);
    expect(textOf(html)).toContain('Remove from roster. Recorded match/session history remains.');
    expect(html).toContain('role="alert"');
    expect(textOf(html)).toContain('Player state changed. Try again.');
    expect(html).not.toContain('<textarea');
    expect(buttonFor(html, 'Cancel')).not.toContain('disabled=""');
    expect(buttonFor(html, 'Remove player')).not.toContain('disabled=""');
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps active-player confirmation blocked even when opened from stale row state', () => {
    const html = renderToStaticMarkup(<RemovePlayerDialog player={player()} busy={false} error={null}
      blockedReason="End the active match before removing this player."
      onRemove={async () => true} onClose={() => undefined} />);
    expect(html).toContain('role="status"');
    expect(textOf(html)).toContain('End the active match before removing this player.');
    expect(buttonFor(html, 'Remove player')).toContain('disabled=""');
  });
});
