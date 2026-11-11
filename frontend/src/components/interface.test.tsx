import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Clock } from './Clock';
import { CourtHistory } from './CourtHistory';
import { Layout } from './Layout';
import { PlayerCard } from './PlayerCard';
import { RosterImportModal } from './RosterImportModal';
import { MatchProposalModal } from './MatchProposalModal';
import { SessionDialog } from './SessionDialog';
import { Roster } from './Roster';
import type { Player } from '../types/models';

const textOf = (markup: string) => markup.replace(/<[^>]*>/g, ' ');

afterEach(() => vi.useRealTimers());

describe('club interface', () => {
  it('keeps commissioning and recording copy out of the working header', () => {
    const text = textOf(renderToStaticMarkup(<Layout onViewChange={() => undefined}>Courts</Layout>));
    expect(text).toContain('Sidecourt');
    expect(text).not.toMatch(/synthetic|sample|demo|commission|Philippines|PHT/i);
  });

  it.each([
    ['2026-01-15T00:00:00Z', '11:00'],
    ['2026-07-15T00:00:00Z', '10:00'],
  ])('formats the Sydney clock across daylight saving at %s', (date, expectedTime) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(date));
    const text = textOf(renderToStaticMarkup(<Clock />));
    expect(text).toContain(expectedTime);
    expect(text).toContain('Sydney');
    expect(text).not.toContain('PHT');
  });

  it('shows a complete player name and local rating without repeating play style', () => {
    const player: Player = {
      id: 'player-one', name: 'Ethan McAllister', skillLevel: 'advanced', skillRating: 4.7,
      playStyle: 'Aggressive', attendance: 'ready', source: null, externalId: null,
      location: { type: 'holding-pool', index: 0 }, createdAt: 1,
    };
    const text = textOf(renderToStaticMarkup(<PlayerCard player={player} />));
    expect(text).toContain('Ethan McAllister');
    expect(text).toContain('Advanced');
    expect(text).toContain('4.7');
    expect(text).not.toContain('Aggressive');
  });

  it('offers the roster CSV example through the real import dialog', () => {
    const markup = renderToStaticMarkup(<RosterImportModal
      returnFocusTo={null} preview={null} result={null} isSaving={false} error={null}
      onPreview={async () => true} onImport={async () => true}
      onClear={() => undefined} onClose={() => undefined}
    />);
    expect(markup).toContain('href="/sample-roster.csv" download="roster-format.csv"');
    const text = textOf(markup);
    expect(text).toContain('Download CSV example');
    expect(text).not.toMatch(/synthetic|sample|demo|no live platform/i);
  });

  it('shows a single CSV entry action on an empty roster', () => {
    const markup = renderToStaticMarkup(<Roster players={[]} courts={[]} disabled={false}
      onImport={() => undefined} onAttendance={async () => true} />);
    expect(textOf(markup)).toContain('No players yet');
    expect(textOf(markup).match(/Import roster CSV/g)).toHaveLength(1);
  });

  it('keeps actual history and Sydney timestamps without summary metric tiles', () => {
    const text = textOf(renderToStaticMarkup(<CourtHistory courtId={1} onClose={() => undefined} history={[{
      id: 'game-one', courtId: 1, players: ['Priya Narayan', 'Noah Tran'],
      startedAt: Date.parse('2026-01-15T00:00:00Z'),
      endedAt: Date.parse('2026-01-15T00:10:00Z'), duration: 600,
    }]} />));
    expect(text).toContain('11:00');
    expect(text).toContain('10m 00s');
    expect(text).toContain('Priya Narayan, Noah Tran');
    expect(text).not.toMatch(/Avg time|History summary/);
  });

  it('uses the configured club name and clock time zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
    const text = textOf(renderToStaticMarkup(<Layout venueName="Riverside Club" timezone="Australia/Perth">Courts</Layout>));
    expect(text).toContain('Riverside Club');
    expect(text).toContain('08:00');
    expect(text).toContain('Perth');
    expect(text).not.toContain('Sydney');
  });

  it('shows the actual session game count instead of a placeholder statistic', () => {
    const player: Player = {
      id: 'player-one', name: 'Ethan McAllister', skillLevel: 'advanced', skillRating: 4.7,
      playStyle: 'Aggressive', attendance: 'ready', source: null, externalId: null,
      location: { type: 'holding-pool', index: 0 }, createdAt: 1, gamesPlayed: 3,
    };
    const markup = renderToStaticMarkup(<Roster players={[player]} courts={[]} disabled={false} onImport={() => undefined} onAttendance={async () => true} />);
    expect(markup).toContain('<th scope="col">Games</th>');
    expect(markup).toContain('<td class="roster-games">3</td>');
  });

  it('reviews two singles teams and an available court without AI marketing copy', () => {
    const player = (id: string): Player => ({
      id, name: id, skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced',
      attendance: 'ready', source: null, externalId: null, location: { type: 'holding-pool', index: 0 }, createdAt: 1,
    });
    const markup = renderToStaticMarkup(<MatchProposalModal
      proposal={{ id: 'p', source: 'rules-fallback', targetLane: 'intermediate', players: [player('Alex'), player('Blair')], summary: '', notice: '', expiresAt: Date.now() + 60_000, status: 'pending' }}
      error={null} isSaving={false} isProposalLoading={false} playerCount={2}
      courts={[{ id: 2, status: 'available', players: [], gameStartedAt: null, timeElapsed: 0 }]}
      onApprove={async () => true} onDismiss={async () => true} onRequestAnother={async () => true}
    />);
    expect(markup).toContain('aria-label="Team 1"');
    expect(markup).toContain('aria-label="Team 2"');
    expect(markup).toContain('Court 2');
    expect(textOf(markup)).toContain('Assign court');
    expect(textOf(markup)).not.toMatch(/\bAI\b|\bfour\b|\blane\b/i);
  });

  it('keeps visitor reset out of private club controls', () => {
    const markup = renderToStaticMarkup(<SessionDialog
      settings={{ venueName: 'Club', courtCount: 2, timezone: 'Australia/Sydney', gameMode: 'doubles' }}
      session={{ id: 'one', name: 'Tuesday social', startedAt: 1, endedAt: null }}
      busy={false} hasActiveMatch={false} error={null} publicAccess={false}
      onClose={() => undefined} onSaveSettings={async () => true} onStart={async () => true}
      onEnd={async () => true} onReset={async () => true}
    />);
    const text = textOf(markup);
    expect(markup).toContain('<dialog');
    expect(text).not.toMatch(/Attendance CSV|Matches CSV/);
    expect(text).not.toContain('Create player view');
    expect(text).not.toContain('Reset');
  });

  it('does not call an assigned court unavailable after successful approval', () => {
    const player = (id: string): Player => ({
      id, name: id, skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced',
      attendance: 'ready', source: null, externalId: null,
      location: { type: 'court', courtId: 1 }, createdAt: 1,
    });
    const players = [player('Alex'), player('Blair'), player('Casey'), player('Drew')];
    const markup = renderToStaticMarkup(<MatchProposalModal
      proposal={{ id: 'assigned', source: 'rules-fallback', targetLane: 'intermediate', players,
        summary: '', notice: '', expiresAt: Date.now() + 60_000, status: 'applied' }}
      error={null} isSaving={false} isProposalLoading={false}
      courts={[{ id: 1, status: 'available', players, gameStartedAt: null, timeElapsed: 0 }]}
      onApprove={async () => true} onDismiss={async () => true} onRequestAnother={async () => true}
    />);
    expect(textOf(markup)).toContain('Assigned');
    expect(textOf(markup)).not.toContain('Choose another court or Next game');
  });
});
