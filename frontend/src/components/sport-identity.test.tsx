import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Court as CourtModel, Player } from '../types/models';
import { EquipmentMark } from './EquipmentMark';
import { Court } from './Court';

const equipment = vi.hoisted(() => ({ load: vi.fn(), mount: vi.fn() }));
vi.mock('../lib/equipmentScene', () => {
  equipment.load();
  return { mountEquipmentScene: equipment.mount };
});

const players: Player[] = ['Alex', 'Blair', 'Casey', 'Drew'].map((name, index) => ({
  id: `player-${index}`, name, skillLevel: 'intermediate', skillRating: index === 1 ? null : 3.2,
  attendance: 'ready', playStyle: 'Balanced', source: null, externalId: null, createdAt: 1,
  location: { type: 'court', courtId: 1 },
}));
const court = (overrides: Partial<CourtModel> = {}): CourtModel => ({
  id: 1, name: 'Garden', status: 'available', players: [], gameStartedAt: null, timeElapsed: 0, ...overrides,
});
const ok = async () => true;
const renderCourt = (value: CourtModel, playerCount = 4, disabled = false): string => renderToStaticMarkup(
  <Court court={value} history={[]} playerCount={playerCount} disabled={disabled}
    onStartGame={ok} onEndGame={ok} onEndAndReview={ok} onToggleStatus={ok} onVoidGame={ok} />,
);
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const buttonFor = (markup: string, label: string): string => {
  const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((candidate) => textOf(candidate) === label || candidate.includes(`aria-label="${label}"`));
  expect(button, `Expected a ${label} control`).toBeDefined();
  return button!;
};
const teamNames = (markup: string, team: number): string[] => {
  const section = markup.match(new RegExp(`aria-label="Team ${team}">([\\s\\S]*?)<\\/section>`))?.[1];
  expect(section).toBeDefined();
  return [...section!.matchAll(/title="([^"]*)"/g)].map((match) => match[1]!);
};

describe('pickleball equipment identity', () => {
  it('provides decorative, nonfocusable SVG fallback without essential controls or extra copy', () => {
    const html = renderToStaticMarkup(<EquipmentMark />);
    expect(html).toMatch(/<div\b[^>]*class="equipment-mark"[^>]*aria-hidden="true"/);
    expect(html).toMatch(/<svg\b[^>]*class="equipment-mark__fallback"[^>]*viewBox="0 0 180 110"[^>]*focusable="false"/);
    expect(html).not.toMatch(/tabindex=|<button\b|<a\b|<input\b|<select\b|<text\b|<title\b|role="img"/);
    expect(textOf(html)).toBe('');
  });

  it('draws a shaped paddle, wrapped grip and perforated ball rather than a generic orb', () => {
    const html = renderToStaticMarkup(<EquipmentMark />);
    const paddle = html.match(/<g transform="[^"]*rotate[^"]*">([\s\S]*?)<\/g>/)?.[1];
    expect(paddle).toBeDefined();
    expect(paddle!.match(/<path\b/g)?.length).toBeGreaterThanOrEqual(5);
    expect(paddle).toMatch(/fill="url\(#[^)]+\)"/);
    expect(html).toMatch(/<pattern\b[^>]*>[\s\S]*fill="#245c46"/);
    expect(paddle).toContain('fill="#192f26"');
    expect(paddle).toMatch(/<path\b[^>]*stroke="#b8c8bd"/);
    const holes = html.match(/<g fill="#245c46">([\s\S]*?)<\/g>/)?.[1];
    expect(holes).toBeDefined();
    expect(holes!.match(/<(?:circle|ellipse)\b/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).not.toMatch(/<image\b|<img\b|https?:\/\//);
  });

  it.each([false, true])('keeps playing=%s server rendering independent of WebGL or a browser', (playing) => {
    const html = renderToStaticMarkup(<EquipmentMark playing={playing} />);
    expect(html).toContain('equipment-mark__fallback');
    expect(html).not.toContain('<canvas');
    expect(equipment.load).not.toHaveBeenCalled();
    expect(equipment.mount).not.toHaveBeenCalled();
  });

  it('keeps procedural weave references unique when more than one study is rendered', () => {
    const html = renderToStaticMarkup(<><EquipmentMark /><EquipmentMark /></>);
    const ids = Array.from(html.matchAll(/<pattern id="([^"]+)"/g), match => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`fill="url(#${id})"`);
    expect(html).not.toMatch(/<image\b|https?:\/\//);
  });
});

describe('sport-specific court presentation', () => {
  it.each([2, 4])('marks exactly %i assigned positions ready once and preserves the Start action', (playerCount) => {
    const html = renderCourt(court({ players: players.slice(0, playerCount) }), playerCount);
    expect(html).toContain('data-ready="true"');
    expect(html).toContain('status-badge--ready');
    expect(textOf(html).match(/\bReady\b/g)).toHaveLength(1);
    expect(textOf(html)).toContain(`${playerCount} / ${playerCount}`);
    expect(buttonFor(html, 'Start')).not.toContain('disabled=""');
    expect(html).not.toContain('court-empty__drawing');
  });

  it.each([2, 4])('keeps a partial %i-position court unready and unable to start', (playerCount) => {
    const html = renderCourt(court({ players: players.slice(0, playerCount - 1) }), playerCount);
    expect(html).toContain('data-ready="false"');
    expect(html).not.toContain('status-badge--ready');
    expect(textOf(html)).not.toMatch(/\bReady\b/);
    expect(textOf(html)).toContain(`${playerCount - 1} / ${playerCount}`);
    expect(buttonFor(html, 'Start')).toContain('disabled=""');
  });

  it('keeps a complete court ready while preventing a second action during saving', () => {
    const html = renderCourt(court({ players }), 4, true);
    expect(html).toContain('data-ready="true"');
    expect(buttonFor(html, 'Start')).toContain('disabled=""');
  });

  it('shows one decorative empty court drawing and one honest unassigned message', () => {
    const html = renderCourt(court());
    expect(html.match(/class="court-empty__drawing"/g)).toHaveLength(1);
    expect(html).toMatch(/<svg\b[^>]*class="court-empty__drawing"[^>]*aria-hidden="true"[^>]*focusable="false"/);
    expect(textOf(html).match(/No group assigned/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Drag players here to assign"');
    expect(html).not.toContain('class="player-card ');
    expect(html).not.toContain('Local rating');
    expect(html).not.toContain('data-ready="true"');
  });

  it('keeps a closed court honest, without an assignment invitation or ready state', () => {
    const empty = renderCourt(court({ status: 'disabled' }));
    expect(empty.match(/class="court-empty__drawing"/g)).toHaveLength(1);
    expect(empty).toContain('aria-label="Court closed"');
    expect(textOf(empty)).toContain('Closed');
    expect(textOf(empty)).not.toContain('No group assigned');
    expect(empty).not.toContain('Drag players here to assign');
    expect(empty).not.toContain('>Start</button>');
    expect(buttonFor(empty, 'Open Garden')).not.toContain('disabled=""');
    const occupied = renderCourt(court({ status: 'disabled', players }));
    expect(occupied).toContain('data-ready="false"');
    expect(textOf(occupied)).not.toMatch(/\bReady\b/);
  });

  it.each([2, 4])('preserves the ordered %i-player teams without inserting illustration content', (playerCount) => {
    const selected = players.slice(0, playerCount);
    const html = renderCourt(court({ players: selected }), playerCount);
    expect(teamNames(html, 1)).toEqual(selected.slice(0, playerCount / 2).map((player) => player.name));
    expect(teamNames(html, 2)).toEqual(selected.slice(playerCount / 2).map((player) => player.name));
    expect(html).toContain('aria-label="Local rating not recorded"');
    expect(html).not.toContain('court-empty__drawing');
    expect(html).not.toContain('equipment-mark');
  });

  it('preserves the real in-play timer, locked roster and turnover controls', () => {
    const html = renderCourt(court({ status: 'in-play', players, gameStartedAt: 1, timeElapsed: 125 }));
    expect(html).toContain('data-ready="false"');
    expect(textOf(html)).toContain('In play');
    expect(textOf(html)).not.toMatch(/\bReady\b/);
    expect(html).toContain('class="court-timer" aria-label="125 seconds elapsed">02:05</time>');
    for (const player of players) expect(html).toContain(`aria-label="${player.name}, roster locked"`);
    for (const label of ['Void', 'End only', 'End &amp; review']) expect(buttonFor(html, label)).not.toContain('disabled=""');
    expect(html).not.toContain('aria-label="Close Garden"');
    expect(textOf(html)).not.toMatch(/score|points|win rate|3D|AI powered|premium/i);
  });
});
