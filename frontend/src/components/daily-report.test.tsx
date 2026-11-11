import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DailyReportContent } from './DailyReportContent';
import { ReportsWorkspace } from './ReportsWorkspace';
import { ReportMatchRecords } from './ReportRecords';
import { reportLocalDate } from '../lib/reportFormatting';
import type { DailyReport, GameHistory } from '../types/models';

const at = Date.parse('2026-11-06T23:00:00Z');
const match: GameHistory = { id: 'one', courtId: 1, courtName: 'Garden',
  players: ['Alex Morgan', 'Blair Chen'], playerIds: ['a', 'b'], sessionId: 's',
  startedAt: at, endedAt: at + 60_000, duration: 60, status: 'completed' };
const report = (): DailyReport => ({ date: '2026-11-07', displayTimezone: 'Australia/Sydney', generatedAt: at,
  totals: { checkedInPlayers: 2, completedMatches: 1, completedCourtSeconds: 60, voidedMatches: 0, correctedMatches: 0 },
  courts: [{ courtId: 1, courtName: 'Garden', completedMatches: 1, completedCourtSeconds: 60, voidedMatches: 0, correctedMatches: 0 }],
  sessions: [{ id: 's', name: 'Saturday social', startedAt: at, endedAt: null }], matches: [match] });
const render = (value: DailyReport) => renderToStaticMarkup(<DailyReportContent report={value} onSelectSession={() => undefined} />);
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

describe('daily owner report', () => {
  it('shows only recorded totals, local date, retained courts and actual match teams', () => {
    const html = render(report());
    expect(text(html)).toContain('7 November 2026');
    expect(text(html)).toContain('Australia/Sydney');
    expect(html).toContain('<dt>Checked in</dt><dd><strong>2</strong></dd>');
    expect(html).toContain('<dt>Completed matches</dt><dd><strong>1</strong></dd>');
    expect(html).toContain('<dt>Completed court time</dt><dd><strong>1m 0s</strong></dd>');
    expect(text(html)).toContain('Garden');
    expect(html).toContain('<span>Team 1</span>Alex Morgan');
    expect(html).toContain('<span>Team 2</span>Blair Chen');
    expect(text(html)).not.toMatch(/revenue|savings|utilization|forecast|average wait|\bAI\b|0 voided|0 corrected/i);
  });
  it('keeps the latest void and correction reasons without implying they add completed time', () => {
    const value = report();
    value.totals.voidedMatches = 1; value.totals.correctedMatches = 1;
    value.matches[0] = { ...match, status: 'voided', correctedAt: at + 120_000, reason: 'Interrupted play' };
    const html = render(value);
    expect(text(html)).toContain('1 voided');
    expect(text(html)).toContain('1 corrected');
    expect(text(html)).toContain('Interrupted play');
    expect(html).toContain('match-record--voided');
  });
  it('retains both recorded names when one court was renamed', () => {
    const value = report();
    value.matches.push({ ...match, id: 'renamed', courtName: 'River' });
    expect(render(value)).toContain('>River</span>');
    expect(render(value)).toContain('>Garden</span>');
  });
  it('has one honest empty state rather than filler analytics', () => {
    const value = report(); value.sessions = []; value.matches = []; value.courts = [];
    value.totals = { checkedInPlayers: 0, completedMatches: 0, completedCourtSeconds: 0, voidedMatches: 0, correctedMatches: 0 };
    const html = render(value);
    expect(text(html)).toContain('No recorded activity for this date.');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('class="report-metrics"');
  });
  it('keeps saved-session selection and accessible period tabs inside Reports', () => {
    const load = vi.fn(async () => null);
    const html = renderToStaticMarkup(<ReportsWorkspace sessionId="s" sessions={report().sessions}
      timezone="Australia/Sydney" onLoad={load} onLoadDay={load}
      onExport={async () => true} error={null} busy={false} />);
    expect(html).toContain('>Reports</h2>');
    expect(html).toContain('role="tablist" aria-label="Report period"');
    expect(html).toContain('>Session</button>');
    expect(html).toContain('>Day</button>');
    expect(html).toContain('Saturday social');
    expect(html).toContain('Loading report…');
    expect(html).toMatch(/disabled=""[^>]*>Print report/);
    expect(load).not.toHaveBeenCalled();
  });
  it('shows six matches per page while retaining every match for printing', () => {
    const matches = Array.from({ length: 19 }, (_, index) => ({ ...match, id: `match-${index}` }));
    const html = renderToStaticMarkup(<ReportMatchRecords matches={matches} timezone="Australia/Sydney" />);
    expect(html.match(/<li /g)).toHaveLength(19);
    expect(html.match(/hidden=""/g)).toHaveLength(13);
    expect(text(html)).toContain('1–6 of 19');
    expect(html).toContain('Next Recorded matches page');
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    expect(css).toContain('.reports-workspace .report-records > li[hidden] { display: list-item !important; }');
    expect(css).toContain('.reports-workspace .report-controls, .reports-workspace .list-pagination { display: none !important; }');
    expect(css).toContain('.reports-workspace .report-details__content[hidden] { display: block !important; }');
  });
  it('computes the initial date in the venue timezone, including the Sydney DST boundary', () => {
    const utc = Date.parse('2026-10-03T14:00:00Z');
    expect(reportLocalDate('Australia/Sydney', utc)).toBe('2026-10-04');
    expect(reportLocalDate('Asia/Manila', utc)).toBe('2026-10-03');
  });
});
