import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CourtName } from './CourtName';
import { HoldingPool } from './HoldingPool';
import type { Player } from '../types/models';

describe('courtside finish', () => {
  it.each(['Court 1', 'Court 06'])('styles only the real number in %s without renaming it', (name) => {
    const html = renderToStaticMarkup(<CourtName name={name} />);
    expect(html).toContain(`aria-label="${name}"`);
    expect(html).toContain('court-name--numbered');
    expect(html).toContain(`class="court-card__number">${name.slice(6)}</span>`);
  });

  it.each(['North', 'Court 2 — Garden', 'Court Steward'])('retains the configured name %s verbatim', (name) => {
    const html = renderToStaticMarkup(<CourtName name={name} />);
    expect(html).toContain(`>${name}</h3>`);
    expect(html).not.toContain('court-card__number');
  });

  it('renders untrusted court names as text rather than executable markup', () => {
    const html = renderToStaticMarkup(<CourtName name={'<img src=x onerror="alert(1)">'} />);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });

  it('keeps queue identity, order, ratings, waiting and games without repeating skill labels', () => {
    const players: Player[] = [1, 2, 3, 4].map((id) => ({
      id: String(id), name: `Queue player ${id}`, skillLevel: 'intermediate', skillRating: id === 4 ? null : 3.2,
      playStyle: 'Balanced', attendance: 'ready', source: null, externalId: null,
      location: { type: 'holding-pool', index: id - 1 }, createdAt: 1, gamesPlayed: id,
    }));
    const html = renderToStaticMarkup(<HoldingPool players={players} onSuggestMatch={() => undefined} />);
    const names = [...html.matchAll(/title="(Queue player \d)"/g)].map(match => match[1]);
    expect(names).toEqual(players.map(player => player.name));
    for (let id = 1; id <= 4; id++) expect(html).toContain(`aria-label="Queue position ${id}"`);
    expect(html).toContain('aria-label="Local rating 3.2"');
    expect(html).toContain('aria-label="Local rating not recorded"');
    expect(html).toContain('aria-label="Current wait"');
    expect(html).toContain('4 games');
    expect(html).not.toContain('>Intermediate</span>');
  });
});
