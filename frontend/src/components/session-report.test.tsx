import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionReport } from '../types/models';
import { SessionReportContent, ReportsWorkspace } from './ReportsWorkspace';
import { SessionDialog } from './SessionDialog';

const startedAt = Date.parse('2026-01-15T00:00:00Z');
const report = (overrides: Partial<SessionReport> = {}): SessionReport => ({
  generatedAt: startedAt + 3600_000,
  displayTimezone: 'Australia/Sydney',
  session: { id: 'session-one', name: 'Thursday social', startedAt, endedAt: null },
  participants: [{ id: 'one', name: 'Alex Morgan', source: 'club-roster', externalId: 'member-001',
    attendance: 'departed', checkedInAt: startedAt + 60_000, gamesPlayed: 1, playedSeconds: 125 },
    { id: 'two', name: 'Blair Chen', source: null, externalId: null, attendance: 'ready',
      checkedInAt: startedAt, gamesPlayed: 1, playedSeconds: 125 }],
  matches: [{ id: 'match-one', sessionId: 'session-one', courtId: 1, courtName: 'Garden',
    players: ['Alex Morgan', 'Blair Chen'], playerIds: ['one', 'two'],
    startedAt, endedAt: startedAt + 125_000, duration: 125, status: 'completed', reason: null, correctedAt: null }],
  totals: { registeredPlayers: 2, checkedInPlayers: 2, completedMatches: 1, voidedMatches: 0,
    correctedMatches: 0, completedCourtSeconds: 125, unattributedCompletedMatches: 0 },
  activeMatches: 0,
  ...overrides,
});
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (value: SessionReport): string => renderToStaticMarkup(<SessionReportContent report={value} />);

describe('read-only session report', () => {
  it('keeps real team divisions when identities are complete', () => {
    const html = render(report());
    expect(html).toContain('<span>Team 1</span>Alex Morgan');
    expect(html).toContain('<span>Team 2</span>Blair Chen');
    expect(textOf(html)).not.toContain('Player identities incomplete.');
  });
  it('disambiguates same-name local participants with their retained identifiers', () => {
    const value = report();
    value.participants[0]!.externalId = null;
    value.participants[1]!.name = value.participants[0]!.name;
    const html = render(value);
    expect(html).toContain('<small>one</small>');
    expect(html).toContain('<small>two</small>');
  });
  it('keeps records out of settings and locks configuration loading during active play', () => {
    const value = report();
    const html = renderToStaticMarkup(<SessionDialog settings={{ venueName: 'Club', courtCount: 2,
      gameMode: 'doubles', timezone: 'Australia/Sydney' }} session={value.session}
      busy={false} hasActiveMatch={true} error={null} publicAccess={false} onClose={() => undefined}
      onSaveSettings={async () => true} onStart={async () => true} onEnd={async () => true}
      onReset={async () => true} />);
    expect(html).toMatch(/disabled=""[^>]*>Import settings/);
    expect(html).toContain('Export settings');
    expect(html).not.toMatch(/View report|Attendance CSV|Matches CSV/);
  });
  it('shows actual session totals and names without invented savings or current configuration', () => {
    const html = render(report());
    expect(textOf(html)).toContain('Thursday social');
    expect(html).toContain('<dt>Checked in</dt><dd><strong>2</strong><small> / 2</small>');
    expect(html).toContain('<dt>Completed matches</dt><dd><strong>1</strong></dd>');
    expect(html).toContain('<dt>Completed court time</dt><dd><strong>2m 5s</strong></dd>');
    expect(textOf(html)).toContain('Completed match starts');
    expect(textOf(html)).toContain('Completed time by court');
    expect(textOf(html)).toContain('Alex Morgan');
    expect(textOf(html)).not.toMatch(/\b(saved|effortless|premium|AI|rotation|Reclub)\b|A\$/i);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  });
  it('keeps participant identity, first check-in and completed time attributable', () => {
    const html = render(report());
    expect(textOf(html)).toContain('club-roster / member-001');
    expect(textOf(html)).toContain('First check-in');
    expect(textOf(html)).toContain('Left');
    expect(html).toContain('<td>1</td><td>2m 5s</td>');
    expect(html).toContain(`dateTime="${new Date(startedAt + 60_000).toISOString()}"`);
  });
  it('prints the display timezone and Sydney daylight saving time', () => {
    const text = textOf(render(report()));
    expect(text).toContain('Australia/Sydney');
    expect(text).toContain('11:00');
    expect(text).toContain('Updated');
    expect(text).not.toContain('historical settings');
  });
  it('retains absent check-in values rather than estimating them', () => {
    const value = report();
    value.participants[0]!.checkedInAt = null;
    const html = render(value);
    expect(html).toContain('<td>—</td>');
  });
  it('shows a closed archive with its recorded closing timestamp', () => {
    const value = report();
    value.session.endedAt = startedAt + 3600_000;
    const html = render(value);
    expect(textOf(html)).toContain('Closed');
    expect(html).toContain(`dateTime="${new Date(value.session.endedAt).toISOString()}"`);
    expect(html).not.toContain('Correct</button>');
    expect(html).not.toContain('Void</button>');
  });
  it('identifies active matches as excluded from completed totals', () => {
    const text = textOf(render(report({ activeMatches: 2 })));
    expect(text).toContain('Completed matches 1 2 in play');
  });
  it('preserves correction and void reasons while reporting the latest record state', () => {
    const value = report();
    value.matches[0] = { ...value.matches[0]!, status: 'voided', correctedAt: startedAt + 200_000,
      reason: 'Interrupted session; no completed game.' };
    const html = render(value);
    expect(textOf(html)).toContain('Voided');
    expect(textOf(html)).toContain('Interrupted session; no completed game.');
    expect(html).toContain('Updated <time');
    expect(html).toContain('match-record--voided');
  });
  it('does not infer missing player identities from retained names', () => {
    const value = report();
    value.matches[0]!.playerIds = [];
    value.totals.unattributedCompletedMatches = 1;
    const text = textOf(render(value));
    expect(text).toContain('Alex Morgan, Blair Chen');
    expect(text).toContain('1 completed match has incomplete player identities.');
    expect(text).toContain('Player identities incomplete.');
    expect(text).not.toContain('Completed games per player');
  });
  it('charts only checked-in players, including those with no completed games', () => {
    const value = report();
    value.participants[0]!.gamesPlayed = 0;
    value.participants[1]!.gamesPlayed = 5;
    value.participants.push({ ...value.participants[0]!, id: 'expected', checkedInAt: null });
    const html = render(value);
    expect(html).toContain('Completed games per player');
    expect(html).toContain('data-band="0"><span>0 games</span><strong>1');
    expect(html).toContain('data-band="4"><span>4+ games</span><strong>1');
  });
  it('renders distinct attendance and match empty states', () => {
    const text = textOf(render(report({ participants: [], matches: [] })));
    expect(text).toContain('No attendance records.');
    expect(text).toContain('No recorded matches.');
  });
  it('loads only after mount and disables exports/printing until report data exists', () => {
    const load = vi.fn(async () => report());
    const exportReport = vi.fn(async () => true);
    const html = renderToStaticMarkup(<ReportsWorkspace sessionId="session-one" onLoad={load}
      onExport={exportReport} error={null} busy={false} />);
    expect(html).toContain('class="reports-workspace"');
    expect(html).not.toContain('<dialog');
    expect(textOf(html)).toContain('Loading report…');
    expect(html).toMatch(/disabled=""[^>]*>Print report/);
    expect(html).toMatch(/disabled=""[^>]*>Attendance CSV/);
    expect(load).not.toHaveBeenCalled();
    expect(exportReport).not.toHaveBeenCalled();
  });
});
