import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { playerIsLocked, playerMoveOptions } from '../lib/playerMoves';
import { PlayerMoveDialog } from './PlayerMoveDialog';
import { HoldingPool } from './HoldingPool';
import { MatchProposalModal } from './MatchProposalModal';
import type { Court, MatchProposal, Player } from '../types/models';

const player: Player = { id: 'one', name: 'Alex Morgan', skillLevel: 'unrated', skillRating: null,
  attendance: 'ready', playStyle: 'Balanced', source: null, externalId: null,
  createdAt: 1, gamesPlayed: 2, location: { type: 'holding-pool', index: 0 } };
const courts: Court[] = [
  { id: 1, name: 'Garden', status: 'available', players: [], gameStartedAt: null, timeElapsed: 0 },
  { id: 2, name: 'Terrace', status: 'in-play', players: [], gameStartedAt: 1, timeElapsed: 2 },
  { id: 3, name: 'Closed court', status: 'disabled', players: [], gameStartedAt: null, timeElapsed: 0 },
];
const ok = async () => true;
const text = (html: string) => html.replace(/<[^>]*>/g, ' ');

describe('player actions without dragging', () => {
  it('offers real destinations and never puts an unrated player in a rated band', () => {
    const options = playerMoveOptions(player, courts, 4);
    expect(options.map((o) => o.value)).toEqual(['next-mixed', 'court-1']);
    expect(options[0]?.destination).toEqual({ type: 'next-game-pool', lane: 'mixed' });
    expect(options[1]?.label).toBe('Garden');
  });
  it('excludes a full court and the current court', () => {
    const assigned: Player = { ...player, location: { type: 'court', courtId: 1 } };
    expect(playerMoveOptions(assigned, courts, 4).map((o) => o.value)).toEqual(['waiting', 'next-mixed']);
    expect(playerMoveOptions(player, [{ ...courts[0]!, players: [player, player] }], 2).map((o) => o.value)).toEqual(['next-mixed']);
  });
  it('offers only the player band and the explicit open group for a rated player', () => {
    const rated: Player = { ...player, skillLevel: 'advanced', skillRating: 4.5 };
    expect(playerMoveOptions(rated, courts, 4).map((o) => o.value)).toEqual(['next-advanced', 'next-mixed', 'court-1']);
  });
  it('locks active rosters and players who have rested or departed', () => {
    expect(playerIsLocked({ ...player, location: { type: 'court', courtId: 2 } }, courts)).toBe(true);
    for (const attendance of ['resting', 'departed', 'expected'] as const) {
      expect(playerMoveOptions({ ...player, attendance }, courts, 4)).toEqual([]);
    }
  });
  it('requires an explicit destination and provides a rest action', () => {
    const html = renderToStaticMarkup(<PlayerMoveDialog player={player} courts={courts} playerCount={4} busy={false} error={null} onClose={() => undefined} onMove={ok} onRest={ok} />);
    expect(html).toContain('Choose destination');
    expect(html).toContain('Garden');
    expect(html).not.toContain('>Terrace</option>');
    expect(html).toMatch(/type="submit"[^>]*disabled=""/);
    expect(text(html)).toContain('Rest');
    expect(text(html)).toContain('2 games');
  });
  it('retains an error inside the dialog and does not invent unknown counts', () => {
    const noCount = { ...player }; delete noCount.gamesPlayed;
    const html = renderToStaticMarkup(<PlayerMoveDialog player={noCount} courts={courts} playerCount={4} busy={false} error="Court is now full." onClose={() => undefined} onMove={ok} onRest={ok} />);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('Court is now full.');
    expect(text(html)).toContain('—');
  });
});

describe('matching disclosure', () => {
  it('offers session rotation without an AI or provider status claim', () => {
    const html = renderToStaticMarkup(<HoldingPool players={Array.from({ length: 8 }, (_, index) => ({ ...player, id: String(index) }))}
      onSuggestMatch={() => undefined} onReviewRotation={() => undefined} />);
    expect(text(html)).toContain('Review rotation');
    expect(text(html)).not.toMatch(/AI-assisted|TogetherAI|Checking service|Rules-based matching/);
    expect(text(html)).toContain('Reviews waiting players across empty courts.');
  });
  it('requires an empty court for the session planner', () => {
    const html = renderToStaticMarkup(<HoldingPool players={Array.from({ length: 8 }, (_, index) => ({ ...player, id: String(index) }))}
      onSuggestMatch={() => undefined} onReviewRotation={() => undefined} rotationAvailable={false} />);
    expect(html).toMatch(/disabled=""[^>]*>Review rotation<\/button>/);
  });
  it.each(['ai', 'rules-fallback'] as const)('keeps historical source context without method filler: %s', (source) => {
    const proposal: MatchProposal = { id: 'review', source, targetLane: 'mixed', players: [player, { ...player, id: 'two' }], summary: '', notice: 'Rules determined this pairing.', expiresAt: Date.now() + 60_000, status: 'pending' };
    const html = renderToStaticMarkup(<MatchProposalModal proposal={proposal} error={null} isSaving={false} isProposalLoading={false} playerCount={2} onApprove={ok} onDismiss={ok} onRequestAnother={ok} />);
    if (source === 'ai') expect(text(html)).toContain('Saved pairing');
    else expect(text(html)).not.toContain('Saved pairing');
    expect(text(html)).not.toContain('Rules-based pairing');
    expect(text(html)).not.toContain('Rules determined this pairing.');
    expect(text(html)).not.toContain('TogetherAI');
  });
  it('marks unknown ratings on the players and keeps mixed approval visible', () => {
    const proposal: MatchProposal = { id: 'review', source: 'rules-fallback', targetLane: 'mixed',
      players: [{ ...player, skillRating: null, skillLevel: 'unrated' }, { ...player, id: 'two' }],
      summary: '', notice: 'Queue selection used bounded cohorts and session history to optimise the pairing.',
      expiresAt: Date.now() + 60_000, status: 'pending', mixed: true };
    const html = renderToStaticMarkup(<MatchProposalModal proposal={proposal} error={null} isSaving={false}
      isProposalLoading={false} playerCount={2} onApprove={ok} onDismiss={ok} onRequestAnother={ok} />);
    expect(html.match(/aria-label="Local rating not recorded">—/g)).toHaveLength(2);
    expect(text(html)).toContain('Allow mixed levels');
    expect(html).toMatch(/disabled=""[^>]*>Stage group/);
    expect(text(html)).not.toContain('numeric balance unavailable');
    expect(text(html)).not.toContain('Queue selection');
    expect(text(html)).not.toContain('bounded cohorts');
  });
});
