import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddPlayerModal } from './AddPlayerModal';
import { Court } from './Court';
import { CourtHistory, MatchCorrectionDialog } from './CourtHistory';
import { HoldingPool } from './HoldingPool';
import { NextGamePool } from './NextGamePool';
import { MatchProposalModal } from './MatchProposalModal';
import { PlayerCard } from './PlayerCard';
import { SessionDialog } from './SessionDialog';
import { formatWait, historyIdentities } from '../lib/board';
import type { GameHistory, Player } from '../types/models';

const player = (id: string): Player => ({ id, name: id, skillLevel: 'unrated', skillRating: null,
  playStyle: 'Balanced', attendance: 'ready', source: null, externalId: null,
  location: { type: 'holding-pool', index: 0 }, createdAt: 1, waitingSince: 60_000, gamesPlayed: 2 });
const game: GameHistory = { id: 'g', courtId: 1, sessionId: 's', players: ['Alex', 'Blair'], playerIds: ['a', 'b'],
  startedAt: 60_000, endedAt: 240_000, duration: 180, status: 'completed' };
const textOf = (markup: string) => markup.replace(/<[^>]*>/g, ' ');
const ok = async () => true;

describe('showcase courtside workflow', () => {
  it('registers without pretending an unknown rating is 3.5', () => {
    const html = renderToStaticMarkup(<AddPlayerModal onAdd={ok} onClose={() => undefined} onClearError={() => undefined} isSaving={false} error={null} />);
    expect(html).toContain('checked="" value="unrated"');
    expect(html).toContain('placeholder="—"');
    expect(html).not.toContain('value="3.5"');
    expect(textOf(html)).toContain('optional');
  });
  it('renders unknown ratings safely', () => {
    const html = renderToStaticMarkup(<PlayerCard player={player('Alex')} />);
    expect(textOf(html)).toContain('Unrated');
    expect(html).toContain('Local rating not recorded');
    expect(textOf(html)).toContain('—');
  });
  it('uses the real current wait, not creation time', () => {
    expect(formatWait(60_000, 181_000)).toBe('2m');
    expect(formatWait(0, 3_660_000)).toBe('1h 1m');
    expect(formatWait(null, 3_660_000)).toBe('—');
    expect(formatWait(1_000, 0)).toBe('0m');
  });
  it('offers explicit mixed review when the oldest band is incomplete', () => {
    const html = renderToStaticMarkup(<HoldingPool players={['A', 'B', 'C', 'D'].map(player)} onSuggestMatch={() => undefined}
      rotation={{ requiredPlayers: 4, eligiblePlayerIds: [], needsMixedApproval: true, waitingBand: 'advanced', missingPlayers: 2 }} />);
    expect(textOf(html)).toContain('Waiting for 2 advanced players');
    expect(textOf(html)).toContain('Review mixed group');
    expect(html).toContain('Queue position 1');
    expect(textOf(html)).toContain('2 games');
  });
  it('does not repeat three empty rated queues', () => {
    const text = textOf(renderToStaticMarkup(<NextGamePool nextGamePool={{ beginner: [], intermediate: [], advanced: [], mixed: [] }} />));
    expect(text).toContain('No group staged');
    expect(text).not.toMatch(/Beginner|Intermediate|Advanced/);
  });
  it('requires an unchecked mixed-level confirmation before assignment', () => {
    const html = renderToStaticMarkup(<MatchProposalModal proposal={{ id: 'p', source: 'rules-fallback', targetLane: 'mixed', mixed: true,
      players: ['A', 'B', 'C', 'D'].map(player), summary: '', notice: '', expiresAt: Date.now() + 60_000, status: 'pending' }}
      error={null} isSaving={false} isProposalLoading={false} onApprove={ok} onDismiss={ok} onRequestAnother={ok} />);
    expect(textOf(html)).toContain('Allow mixed levels');
    expect(html).toMatch(/type="checkbox"\/>/);
    expect(html).toMatch(/disabled="">Stage group/);
  });
  it('gives each court named teams and a distinct void action', () => {
    const html = renderToStaticMarkup(<Court court={{ id: 1, name: 'Garden', status: 'in-play', players: ['A', 'B', 'C', 'D'].map(player), gameStartedAt: 1, timeElapsed: 5 }} history={[]} onStartGame={ok} onEndGame={ok} onToggleStatus={ok} onVoidGame={ok} />);
    expect(textOf(html)).toContain('Garden');
    expect(html).toContain('aria-label="Team 1"');
    expect(html).toContain('aria-label="Team 2"');
    expect(textOf(html)).toContain('End match');
    expect(textOf(html)).toContain('Void');
  });
  it('distinguishes voided history and keeps archives read-only', () => {
    const current = renderToStaticMarkup(<CourtHistory courtId={1} history={[game]} sessionId="s" sessionOpen onClose={() => undefined} onVoid={ok} onCorrect={ok} />);
    expect(textOf(current)).toContain('Correct');
    const archived = renderToStaticMarkup(<CourtHistory courtId={1} history={[{ ...game, status: 'voided', reason: 'Wrong start' }]} sessionId="s" sessionOpen={false} onClose={() => undefined} onVoid={ok} onCorrect={ok} />);
    expect(textOf(archived)).toContain('Voided');
    expect(textOf(archived)).toContain('Wrong start');
    expect(archived).not.toContain('>Correct</button>');
    expect(archived).not.toContain('>Void</button>');
  });
  it('retains removed historical identities in correction choices', () => {
    const identities = historyIdentities([player('new')], [game]);
    expect(identities).toContainEqual({ id: 'a', name: 'Alex' });
    const html = renderToStaticMarkup(<MatchCorrectionDialog game={game} identities={identities} busy={false} error={null} onClose={() => undefined} onSave={ok} />);
    expect(html).toContain('<option value="a" selected="">Alex</option>');
    expect(textOf(html)).toContain('Minutes');
    expect(textOf(html)).toContain('Seconds');
    expect(textOf(html)).toContain('Reason');
  });
  it('configures names and house rotation without feature prose', () => {
    const html = renderToStaticMarkup(<SessionDialog settings={{ venueName: 'Club', courtCount: 2, courtNames: ['Garden', 'Terrace'], timezone: 'Australia/Sydney', gameMode: 'doubles', rotationMode: 'skill-banded', avoidRepeatPartners: true }}
      session={{ id: 's', name: 'Social', startedAt: 1, endedAt: null }} busy={false} hasActiveMatch={false} error={null} publicAccess={false} onClose={() => undefined} onSaveSettings={ok} onStart={ok} onEnd={ok} onReset={ok} />);
    expect(html).toContain('value="Garden"');
    expect(html).toContain('value="Terrace"');
    expect(textOf(html)).toContain('Vary partners');
    expect(textOf(html)).toContain('Skill-banded');
  });
});
