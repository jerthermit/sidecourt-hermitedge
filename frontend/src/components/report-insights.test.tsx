import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatStartIntervals, summarizeCompletedPlay } from '../lib/reportInsights';
import type { GameHistory } from '../types/models';
import { ReportInsights } from './ReportInsights';

const timezone = 'Australia/Sydney';
const record = (id: string, start: string, overrides: Partial<GameHistory> = {}): GameHistory => {
  const startedAt = Date.parse(start);
  return { id, courtId: 1, courtName: 'Garden', players: [], startedAt, endedAt: startedAt + 60_000,
    duration: 60, status: 'completed', ...overrides };
};

describe('completed play insights', () => {
  it('uses final records, preserves court names and identities, and reports exact values', () => {
    const matches = [
      record('late', '2026-11-07T01:20:00Z', { courtName: 'River', duration: 0 }),
      record('void', '2026-11-07T02:20:00Z', { courtName: 'Voided court', duration: 800, status: 'voided' }),
      record('legacy', '2026-11-06T23:20:00Z', { status: undefined }),
      record('corrected', '2026-11-06T23:30:00Z', { duration: 125, correctedAt: Date.parse('2026-11-07T02:30:00Z') }),
      record('other-court', '2026-11-06T23:45:00Z', { courtId: 2, duration: 92 }),
    ];
    const summary = summarizeCompletedPlay(matches, timezone)!;
    expect(summary.starts.map(({ count }) => count)).toEqual([3, 0, 1]);
    expect(summary.courts).toEqual([
      { courtId: 1, courtName: 'Garden', matches: 2, seconds: 185 },
      { courtId: 2, courtName: 'Garden', matches: 1, seconds: 92 },
      { courtId: 1, courtName: 'River', matches: 1, seconds: 0 },
    ]);
    const html = renderToStaticMarkup(<ReportInsights matches={matches} timezone={timezone} />);
    expect(html).toContain('7 Nov 2026 · 1-hour intervals');
    expect(html).toContain('Peak of 3 starts in the interval beginning 10:00 am.');
    expect(html).toContain('Garden<small> (court 1)</small>');
    expect(html).toContain('Garden<small> (court 2)</small>');
    expect(html).toContain('>River</span>');
    expect(html).toContain('>3:05</span>');
    expect(html).toContain('>3 minutes, 5 seconds</span>');
    expect(html).toContain('dateTime="PT185S"');
    expect(html).toContain('>0:00</span>');
    expect(html).toContain('>Min:sec</span><span>Matches</span>');
    expect(html).toContain('class="report-insights__column" style="height:100%"');
    expect(html).toContain('class="report-insights__column" style="height:0%"');
    expect(html).not.toContain('Voided court');
    expect(html).not.toContain('<table');
  });

  it('distinguishes repeated local times in chronological order and skips a nonexistent clock hour', () => {
    const autumn = summarizeCompletedPlay([
      record('later', '2026-04-04T16:20:00Z'), record('earlier', '2026-04-04T15:20:00Z'),
    ], timezone)!;
    const { intervals: repeated } = formatStartIntervals(autumn.starts, timezone);
    expect(repeated.map(({ count }) => count)).toEqual([1, 1]);
    expect(repeated.map(({ time }) => time)).toEqual(['2:00 am GMT+11', '2:00 am GMT+10']);
    expect(repeated.map(({ axisTime, axisOffset }) => [axisTime, axisOffset])).toEqual([['02:00', '+11'], ['02:00', '+10']]);

    const spring = summarizeCompletedPlay([
      record('later', '2026-10-03T16:30:00Z'), record('earlier', '2026-10-03T15:30:00Z'),
    ], timezone)!;
    expect(formatStartIntervals(spring.starts, timezone).intervals.map(({ time }) => time)).toEqual(['1:00 am', '3:00 am']);
  });

  it('starts on the venue clock and keeps long cross-date spans bounded', () => {
    const short = summarizeCompletedPlay([record('earlier', '2026-11-07T04:35:00Z')], 'Asia/Kathmandu')!;
    expect(short.starts[0]?.at).toBe(Date.parse('2026-11-07T04:15:00Z'));
    expect(formatStartIntervals(short.starts, 'Asia/Kathmandu').intervals[0]?.time).toBe('10:00 am');

    const long = summarizeCompletedPlay([
      record('late', '2027-02-01T04:35:00Z'), record('early', '2025-10-07T04:35:00Z'),
    ], timezone)!;
    expect(long.starts.length).toBeLessThanOrEqual(8);
    expect(long.starts.reduce((sum, interval) => sum + interval.count, 0)).toBe(2);
    expect(long.starts[0]?.count).toBe(1);
    expect(long.starts.at(-1)?.count).toBe(1);
    expect(formatStartIntervals(long.starts, timezone).intervals[0]?.date).toBe('7 Oct 2025');
  });

  it('describes tied peaks without choosing a winner and leaves empty reports plain', () => {
    const matches = [
      record('early-1', '2026-11-06T23:00:00Z'), record('early-2', '2026-11-06T23:30:00Z'),
      record('late-1', '2026-11-07T01:00:00Z'), record('late-2', '2026-11-07T01:30:00Z'),
    ];
    const html = renderToStaticMarkup(<ReportInsights matches={matches} timezone={timezone} />);
    expect(html).toContain('Peak of 2 starts in 2 intervals.');
    expect(html.match(/data-peak/g)).toHaveLength(2);
    const onlyVoided = [{ ...matches[0]!, status: 'voided' as const }];
    expect(renderToStaticMarkup(<ReportInsights matches={onlyVoided} timezone={timezone} />))
      .toBe('<p class="queue-empty">No completed matches.</p>');
  });

  it('keeps a full 16-court ledger, with stable ties and a shared scale', () => {
    const matches = Array.from({ length: 16 }, (_, index) => record(`court-${index}`, '2026-11-07T01:20:00Z', {
      courtId: index + 1, courtName: `Court ${index + 1}`, duration: index < 2 ? 60 : 120,
    }));
    const html = renderToStaticMarkup(<ReportInsights matches={matches} timezone={timezone} showStartDate={false} />);
    expect(html.match(/class="report-insights__court"/g)).toHaveLength(16);
    expect(html.indexOf('>Court 3</span>')).toBeLessThan(html.indexOf('>Court 16</span>'));
    expect(html.indexOf('>Court 16</span>')).toBeLessThan(html.indexOf('>Court 1</span>'));
    expect(html.indexOf('>Court 1</span>')).toBeLessThan(html.indexOf('>Court 2</span>'));
    expect(html.match(/style="width:50%"/g)).toHaveLength(2);
    expect(html).not.toContain('7 Nov 2026');
  });
});
