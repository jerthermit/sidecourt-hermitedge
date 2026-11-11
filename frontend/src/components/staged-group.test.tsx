import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Court, Player } from '../types/models';
import { NextGamePool } from './NextGamePool';
import { StagedGroupDialog } from './StagedGroupDialog';

const players: Player[] = ['Alex', 'Blair', 'Casey', 'Drew'].map((name, index) => ({
  id: `player-${index}`, name, skillLevel: 'intermediate', skillRating: index === 1 ? null : 3.2,
  attendance: 'ready', playStyle: 'Balanced', source: null, externalId: null, createdAt: 1,
  location: { type: 'next-game-pool', lane: 'intermediate' },
}));
const court = (id: number, overrides: Partial<Court> = {}): Court => ({
  id, name: `Court ${id}`, status: 'available', players: [], gameStartedAt: null, timeElapsed: 0, ...overrides,
});
const props = (overrides: Partial<ComponentProps<typeof StagedGroupDialog>> = {}): ComponentProps<typeof StagedGroupDialog> => ({
  sessionId: 'session-one', lane: 'intermediate', players, courts: [court(1, { name: 'Garden' })],
  playerCount: 4, requireMixedApproval: false, stale: false, busy: false, error: null,
  onAssign: vi.fn(async () => true), onRefresh: vi.fn(async () => undefined), onClose: vi.fn(), ...overrides,
});
const renderDialog = (overrides: Partial<ComponentProps<typeof StagedGroupDialog>> = {}): string =>
  renderToStaticMarkup(<StagedGroupDialog {...props(overrides)} />);
const renderPool = (staged: Player[], playerCount = 4, disabled = false): string => renderToStaticMarkup(
  <NextGamePool nextGamePool={{ beginner: [], intermediate: staged, advanced: [], mixed: [] }}
    playerCount={playerCount} disabled={disabled} onAssignGroup={() => undefined} />,
);
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const buttonFor = (markup: string, label: string): string => {
  const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((candidate) => textOf(candidate) === label || candidate.includes(`aria-label="${label}"`));
  expect(button, `Expected a ${label} control`).toBeDefined();
  return button!;
};
const teamNames = (markup: string, team: number): string[] => {
  const list = markup.match(new RegExp(`aria-label="Staged team ${team}">([\\s\\S]*?)<\\/ol>`))?.[1];
  expect(list).toBeDefined();
  return [...list!.matchAll(/<li><span>([^<]*)/g)].map((match) => match[1]!);
};

describe('staged group handoff presentation', () => {
  it.each([2, 4])('offers group assignment for %i complete positions and hides it for a partial group', (playerCount) => {
    const complete = renderPool(players.slice(0, playerCount), playerCount);
    expect(buttonFor(complete, 'Assign group')).not.toContain('disabled=""');
    const partial = renderPool(players.slice(0, playerCount - 1), playerCount);
    expect(partial).not.toContain('>Assign group</button>');
    expect(partial.match(/class="player-card /g)).toHaveLength(playerCount - 1);
  });

  it('disables group assignment while saving and keeps only occupied lanes visible', () => {
    const html = renderPool(players, 4, true);
    expect(buttonFor(html, 'Assign group')).toContain('disabled=""');
    expect(html).toContain('<h3 id="lane-intermediate">Intermediate</h3>');
    expect(html).not.toContain('No group staged');
    expect(html).not.toContain('lane-beginner');
    expect(html).not.toContain('lane-advanced');
    expect(html).not.toContain('lane-mixed');
    expect(html.match(/>Assign group<\/button>/g)).toHaveLength(1);
  });

  it('shows one honest empty lane without player cards, counts or assignment controls', () => {
    const html = renderPool([]);
    expect(textOf(html).match(/No group staged/g)).toHaveLength(1);
    expect(html).not.toContain('class="player-card ');
    expect(html).not.toContain('count-badge');
    expect(html).not.toContain('Assign group');
    expect(html).not.toContain('<h3');
  });

  it('requires an explicit court choice and excludes occupied, active and closed courts', () => {
    const html = renderDialog({ courts: [court(1, { name: 'Garden' }), court(2, { name: 'Assigned court', players: players.slice(0, 1) }),
      court(3, { name: 'Active court', status: 'in-play' }), court(4, { name: 'Closed court', status: 'disabled' }),
      court(5, { name: 'Terrace' })] });
    expect(html).toContain('<option value="" selected="">Choose court</option>');
    expect(html).toContain('<option value="1">Garden</option>');
    expect(html).toContain('<option value="5">Terrace</option>');
    expect(html).not.toMatch(/Assigned court|Active court|Closed court/);
    expect(html.match(/selected=""/g)).toHaveLength(1);
    expect(buttonFor(html, 'Assign court')).toMatch(/type="submit"[^>]*disabled=""/);
  });

  it.each([2, 4])('preserves the reviewed team order for %i positions', (playerCount) => {
    const selected = players.slice(0, playerCount);
    const html = renderDialog({ players: selected, playerCount });
    expect(teamNames(html, 1)).toEqual(selected.slice(0, playerCount / 2).map((player) => player.name));
    expect(teamNames(html, 2)).toEqual(selected.slice(playerCount / 2).map((player) => player.name));
    expect(html).not.toContain('Staged group changed');
    expect(html).toContain('aria-label="Local rating not recorded">—</small>');
    expect(html).toContain('>3.2</small>');
    expect(html).not.toContain('3.5');
  });

  it.each([2, 4])('requires refreshing a partial %i-position group instead of allowing submission', (playerCount) => {
    const html = renderDialog({ players: players.slice(0, playerCount - 1), playerCount });
    expect(textOf(html)).toContain('Staged group changed. Refresh before assigning.');
    expect(buttonFor(html, 'Refresh group')).toContain('type="button"');
    expect(html).not.toContain('type="submit"');
  });

  it.each([
    { stale: true },
    { players: [players[0]!, players[1]!, players[0]!, players[3]!] },
    { error: 'The court changed. Refresh before assigning.' },
  ])('offers refresh instead of submit when the group is stale, duplicated or rejected: %j', (overrides) => {
    const html = renderDialog(overrides);
    expect(buttonFor(html, 'Refresh group')).toContain('type="button"');
    expect(html).not.toContain('type="submit"');
    if ('error' in overrides) {
      expect(html).toContain('role="alert"');
      expect(textOf(html)).toContain(overrides.error);
    } else expect(textOf(html)).toContain('Staged group changed. Refresh before assigning.');
  });

  it('starts mixed approval unchecked and never substitutes an available court for that approval', () => {
    const html = renderDialog({ lane: 'mixed', requireMixedApproval: true });
    expect(textOf(html)).toContain('Allow mixed levels');
    expect(html).toMatch(/<input type="checkbox"\s*\/>/);
    expect(html).not.toContain('checked=""');
    expect(buttonFor(html, 'Assign court')).toContain('disabled=""');
    expect(renderDialog()).not.toContain('type="checkbox"');
  });

  it('disables close, cancel, court choice, mixed approval and refresh while saving', () => {
    const busy = renderDialog({ busy: true, requireMixedApproval: true });
    expect(buttonFor(busy, 'Close staged group review')).toContain('disabled=""');
    expect(buttonFor(busy, 'Cancel')).toContain('disabled=""');
    expect(buttonFor(busy, 'Assigning…')).toContain('disabled=""');
    expect(busy).toMatch(/<select\b[^>]*disabled=""/);
    expect(busy).toMatch(/<input type="checkbox"[^>]*disabled=""/);
    const stale = renderDialog({ busy: true, stale: true });
    expect(buttonFor(stale, 'Refresh group')).toContain('disabled=""');
  });

  it('explains when no empty court is available without inventing a destination', () => {
    const html = renderDialog({ courts: [court(1, { status: 'disabled' }), court(2, { status: 'in-play' }),
      court(3, { players: players.slice(0, 1) })] });
    expect(textOf(html)).toContain('No empty court available.');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<option');
    expect(buttonFor(html, 'Assign court')).toContain('disabled=""');
  });

  it('renders review controls without issuing assignments or refreshing on render', () => {
    const value = props();
    renderToStaticMarkup(<StagedGroupDialog {...value} />);
    expect(value.onAssign).not.toHaveBeenCalled();
    expect(value.onRefresh).not.toHaveBeenCalled();
    expect(value.onClose).not.toHaveBeenCalled();
  });
});
