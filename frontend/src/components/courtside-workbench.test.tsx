import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Court } from './Court';
import { CourtsGrid } from './Layout';
import { HoldingPool } from './HoldingPool';
import { NextGamePool } from './NextGamePool';
import { Roster } from './Roster';
import type { Court as CourtModel, Player } from '../types/models';

const ok = async () => true;
const player = (id: string, skillRating: number | null = 3.2): Player => ({
  id, name: `Player ${id}`, skillRating,
  skillLevel: skillRating === null ? 'unrated' : 'intermediate',
  attendance: 'ready', playStyle: 'Balanced', source: null, externalId: null,
  location: { type: 'court', courtId: 1 }, createdAt: 1, gamesPlayed: 0,
});
const court = (overrides: Partial<CourtModel> = {}): CourtModel => ({
  id: 1, name: 'Garden', status: 'available', players: [], gameStartedAt: null,
  timeElapsed: 0, ...overrides,
});
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const buttonFor = (markup: string, label: string): string => {
  const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((candidate) => textOf(candidate) === label || candidate.includes(`aria-label="${label}"`));
  expect(button, `Expected a ${label} control`).toBeDefined();
  return button!;
};
const renderCourt = (value: CourtModel, playerCount = 4, disabled = false): string => renderToStaticMarkup(
  <Court court={value} history={[]} playerCount={playerCount} disabled={disabled}
    onStartGame={ok} onEndGame={ok} onToggleStatus={ok} onVoidGame={ok} />,
);

describe('courtside workbench presentation', () => {
  it('preserves actual games in the narrow roster layout without inventing unknown counts', () => {
    const known = { ...player('Alex'), gamesPlayed: 1 };
    const unknown = player('Blair');
    delete unknown.gamesPlayed;
    const markup = renderToStaticMarkup(<Roster players={[known, unknown]} courts={[]} disabled={false} onImport={() => undefined} onAttendance={ok} />);
    expect(markup).toContain('<small class="roster-mobile-games">1 game</small>');
    expect(markup).toContain('<small class="roster-mobile-games">— games</small>');
    expect(markup).toContain('<td class="roster-games">1</td>');
    expect(markup).toContain('<td class="roster-games">—</td>');
  });
  it.each([1, 2, 6])('keeps the configured %i-court count and physical order', (courtCount) => {
    const markup = renderToStaticMarkup(<CourtsGrid courtCount={courtCount}>
      {Array.from({ length: courtCount }, (_, index) => <article key={index} aria-label={`Court ${index + 1}`} />)}
    </CourtsGrid>);
    expect(markup).toContain(`data-courts="${courtCount}"`);
    expect(markup.match(/<article\b/g)).toHaveLength(courtCount);
    const labels = [...markup.matchAll(/aria-label="Court (\d+)"/g)].map((match) => Number(match[1]));
    expect(labels).toEqual(Array.from({ length: courtCount }, (_, index) => index + 1));
  });

  it('names the court article and retains explicit, correctly ordered teams', () => {
    const markup = renderCourt(court({ players: ['Alex', 'Blair', 'Casey', 'Drew'].map((id) => player(id)) }));
    expect(markup).toMatch(/<article\b[^>]*aria-label="Garden"/);
    const first = markup.match(/<section\b[^>]*aria-label="Team 1"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    const second = markup.match(/<section\b[^>]*aria-label="Team 2"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(textOf(first!)).toContain('Player Alex');
    expect(textOf(first!)).toContain('Player Blair');
    expect(textOf(first!)).not.toContain('Player Casey');
    expect(textOf(second!)).toContain('Player Casey');
    expect(textOf(second!)).toContain('Player Drew');
    expect(buttonFor(markup, 'Start')).not.toContain('disabled=""');
  });

  it('renders actual local ratings and never invents an unknown rating', () => {
    const markup = renderCourt(court({ players: [player('Alex', 3.7), player('Blair', null)] }));
    expect(markup).toContain('aria-label="Local rating 3.7"');
    expect(markup).toContain('aria-label="Local rating not recorded"');
    expect(textOf(markup)).toContain('—');
    expect(textOf(markup)).not.toContain('3.5');
  });

  it('shows one honest empty doubles state without fabricated players', () => {
    const markup = renderCourt(court());
    expect(textOf(markup).match(/No group assigned/g)).toHaveLength(1);
    expect(textOf(markup)).toContain('0 / 4');
    expect(markup).toContain('aria-label="Garden roster"');
    expect(markup).not.toContain('Local rating');
    expect(markup).not.toContain('Move Player');
    expect(buttonFor(markup, 'Start')).toContain('disabled=""');
  });

  it('preserves actual occupancy in a partially assigned doubles court', () => {
    const markup = renderCourt(court({ players: ['Alex', 'Blair', 'Casey'].map((id) => player(id)) }));
    expect(textOf(markup)).toContain('3 / 4');
    expect(markup.match(/aria-label="Move Player /g)).toHaveLength(3);
    expect(buttonFor(markup, 'Start')).toContain('disabled=""');
  });

  it('keeps an unassigned team explicit without inventing its players', () => {
    const markup = renderCourt(court({ players: [player('Alex')] }));
    const second = markup.match(/<section\b[^>]*aria-label="Team 2"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    expect(second).toBeDefined();
    expect(textOf(second!)).toContain('Unassigned');
    expect(second).not.toContain('Local rating');
    expect(markup.match(/aria-label="Move Player /g)).toHaveLength(1);
  });

  it('uses two real positions for singles rather than doubles occupancy', () => {
    const empty = renderCourt(court(), 2);
    expect(textOf(empty)).toContain('0 / 2');
    const assigned = renderCourt(court({ players: [player('Alex'), player('Blair')] }), 2);
    expect(assigned).not.toContain('Unassigned');
    expect(assigned.match(/aria-label="Team [12]"/g)).toHaveLength(2);
    expect(assigned.match(/aria-label="Move Player /g)).toHaveLength(2);
    expect(buttonFor(assigned, 'Start')).not.toContain('disabled=""');
  });

  it('shows the actual elapsed match time and locks active rosters', () => {
    const players = ['Alex', 'Blair', 'Casey', 'Drew'].map((id) => player(id));
    const markup = renderCourt(court({ status: 'in-play', players, gameStartedAt: 1, timeElapsed: 125 }));
    expect(markup).toContain('aria-label="125 seconds elapsed"');
    expect(textOf(markup)).toContain('02:05');
    for (const item of players) expect(markup).toContain(`aria-label="${item.name}, roster locked"`);
    expect(markup).not.toContain('aria-label="Close Garden"');
    expect(buttonFor(markup, 'End match')).not.toContain('disabled=""');
    expect(buttonFor(markup, 'Void')).not.toContain('disabled=""');
    expect(markup).not.toMatch(/>Start<\/button>/);
    expect(textOf(markup)).not.toMatch(/score|win rate|points|utilisation/i);
  });

  it('exposes the correct reopen control without a start action on a closed court', () => {
    const markup = renderCourt(court({ status: 'disabled' }));
    expect(textOf(markup)).toContain('Closed');
    expect(buttonFor(markup, 'Open Garden')).not.toContain('disabled=""');
    expect(markup).not.toMatch(/>Start<\/button>|>End match<\/button>/);
  });

  it('disables consequential court controls while a state change is pending', () => {
    const ready = renderCourt(court({ players: ['Alex', 'Blair', 'Casey', 'Drew'].map((id) => player(id)) }), 4, true);
    expect(buttonFor(ready, 'Start')).toContain('disabled=""');
    expect(buttonFor(ready, 'Close Garden')).toContain('disabled=""');
    const active = renderCourt(court({ status: 'in-play', players: [player('Alex')], gameStartedAt: 1 }), 4, true);
    expect(buttonFor(active, 'End match')).toContain('disabled=""');
    expect(buttonFor(active, 'Void')).toContain('disabled=""');
  });

  it('renders actions without firing host callbacks during presentation', () => {
    const start = vi.fn(ok);
    const end = vi.fn(ok);
    const toggle = vi.fn(ok);
    const select = vi.fn();
    renderToStaticMarkup(<Court court={court({ players: [player('Alex')] })} history={[]}
      onStartGame={start} onEndGame={end} onToggleStatus={toggle} onSelectPlayer={select} />);
    for (const callback of [start, end, toggle, select]) expect(callback).not.toHaveBeenCalled();
  });

  it('retains one empty staging drop target without repeating empty skill bands', () => {
    const markup = renderToStaticMarkup(<NextGamePool nextGamePool={{ beginner: [], intermediate: [], advanced: [], mixed: [] }} />);
    expect(markup).toContain('class="next-game-pool" data-empty="true"');
    expect(markup).toContain('aria-label="Open group staging"');
    expect(markup).toContain('aria-label="Open group next-game queue drop area"');
    expect(textOf(markup).match(/No group staged/g)).toHaveLength(1);
    expect(textOf(markup)).not.toMatch(/Beginner|Intermediate|Advanced/);
  });

  it.each(['beginner', 'intermediate', 'advanced', 'mixed'] as const)('preserves the occupied %s staging lane and player order', (lane) => {
    const pool = { beginner: [], intermediate: [], advanced: [], mixed: [], [lane]: [player('Alex'), player('Blair')] };
    const markup = renderToStaticMarkup(<NextGamePool nextGamePool={pool} />);
    expect(markup).toContain('class="next-game-pool" data-empty="false"');
    expect(markup.match(/aria-label="Move Player /g)).toHaveLength(2);
    expect(markup.indexOf('Move Player Alex')).toBeLessThan(markup.indexOf('Move Player Blair'));
    expect(textOf(markup)).not.toContain('No group staged');
    expect(markup).toContain('aria-label="2 players staged"');
  });

  it('keeps a short real queue ineligible for matching without marketing or price copy', () => {
    const markup = renderToStaticMarkup(<HoldingPool players={[player('Alex')]} playerCount={4}
      onSuggestMatch={() => undefined} />);
    expect(textOf(markup)).not.toContain('AI-assisted matching');
    expect(textOf(markup)).not.toContain('TogetherAI');
    expect(buttonFor(markup, 'Review match')).toContain('disabled=""');
    expect(markup).toContain('aria-label="Queue position 1"');
    expect(textOf(markup)).not.toMatch(/premium|revolutionary|seamless|unleash|A\$|AUD|3000|3,000|win rate/i);
  });
});
