/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { Court } from './Court';
import { PlayerDisplayContent } from './PlayerDisplay';
import type { Court as CourtModel, Player, PlayerDisplay } from '../types/models';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

const players: Player[] = ['Alex Morgan', 'Blair Chen', 'Casey Patel', 'Drew Taylor'].map((name, index) => ({
  id: `player-${index}`, name, skillLevel: 'intermediate', skillRating: 3.2,
  attendance: 'ready', playStyle: 'Balanced', source: null, externalId: null,
  createdAt: 1, location: { type: 'court', courtId: 1 },
}));
const court = (status: CourtModel['status'] = 'available'): CourtModel => ({
  id: 1, name: 'North', status, players, gameStartedAt: status === 'in-play' ? 1 : null, timeElapsed: 125,
});
const renderCourt = (value: CourtModel, disabled = false) => renderToStaticMarkup(<Court
  court={value} history={[]} disabled={disabled} onStartGame={async () => true}
  onEndGame={async () => true} onToggleStatus={async () => true} />);
const playerRow = (html: string, label: string) => html.match(/<div\b[^>]*>/g)?.find((tag) => tag.includes(`aria-label="${label}"`));
const colour = (name: string): string => css.match(new RegExp(`--${name}:\\s*(#[\\da-f]{6})\\s*;`, 'i'))![1]!;
const luminance = (hex: string): number => {
  const values = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
};
const contrast = (first: string, second: string): number => {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
};

describe('court keyboard accessibility', () => {
  it('keeps assigned-player movement keyboard-accessible before play', () => {
    const html = renderCourt(court());
    for (const player of players) expect(playerRow(html, `Move ${player.name}`)).toContain('tabindex="0"');
  });

  it.each(['playing', 'saving'] as const)('removes unavailable player actions from the tab order while %s', (state) => {
    const html = renderCourt(court(state === 'playing' ? 'in-play' : 'available'), state === 'saving');
    for (const player of players) {
      const row = playerRow(html, `${player.name}, roster locked`);
      expect(row).toContain('aria-disabled="true"');
      expect(row).toContain('tabindex="-1"');
      expect(row).not.toContain('tabindex="0"');
    }
  });

  it('preserves the playing surface under programmatic focus and uses a contrasting focus outline', () => {
    const rule = css.match(/\.court-card--in-play \.drag-item\[aria-disabled="true"\]:focus-visible\s*\{([^}]*)\}/)?.[1];
    expect(rule).toContain('background: transparent;');
    expect(rule).toContain('outline-color: var(--surface-raised);');
    expect(contrast('#ffffff', colour('brand'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#d1e4d9', colour('brand'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colour('surface-raised'), colour('brand'))).toBeGreaterThanOrEqual(3);
  });
});

describe('shared ready-state styling', () => {
  const display = (value: CourtModel): PlayerDisplay => ({
    settings: { venueName: 'Harbour', courtCount: 1, timezone: 'Australia/Sydney', gameMode: 'doubles' },
    session: { id: 'session', name: 'Club session', startedAt: 1, endedAt: null },
    courts: [value], nextGamePool: { beginner: [], intermediate: [], advanced: [], mixed: [] },
  });
  const renderDisplay = (value: CourtModel) => renderToStaticMarkup(<PlayerDisplayContent
    state={display(value)} lastUpdatedAt={1000} now={1000} error={null} expired={false} onRetry={() => undefined} />);

  it('uses the same green Ready class on a complete unstarted court in both views', () => {
    for (const html of [renderCourt(court()), renderDisplay(court())]) {
      expect(html).toMatch(/class="status-badge[^"]*status-badge--ready">Ready<\/span>/);
    }
  });

  it.each(['empty', 'partial', 'in-play', 'disabled'] as const)('does not mark a %s player-screen court Ready', (state) => {
    const value = court(state === 'in-play' || state === 'disabled' ? state : 'available');
    if (state === 'empty') value.players = [];
    if (state === 'partial') value.players = players.slice(0, 3);
    expect(renderDisplay(value)).not.toContain('status-badge--ready');
  });
});
