import { useId, type ReactNode } from 'react';
import { formatStartIntervals, summarizeCompletedPlay } from '../lib/reportInsights';
import type { GameHistory } from '../types/models';
import './ReportInsights.css';

function CourtDuration({ seconds }: { seconds: number }) {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return <time className="report-insights__court-value" dateTime={`PT${seconds}S`}>
    <span aria-hidden="true">{minutes}:{String(remaining).padStart(2, '0')}</span>
    <span className="sr-only">{minutes} {minutes === 1 ? 'minute' : 'minutes'}, {remaining} {remaining === 1 ? 'second' : 'seconds'}</span>
  </time>;
}

export function ReportInsights({ matches, timezone, showStartDate = true, children }: {
  matches: GameHistory[]; timezone: string; showStartDate?: boolean; children?: ReactNode;
}) {
  const id = useId();
  const summary = summarizeCompletedPlay(matches, timezone);
  if (!summary) return <p className="queue-empty">No completed matches.</p>;

  const { busiest, courts, hours, longestCourtTime, starts } = summary;
  const { intervals, singleDate } = formatStartIntervals(starts, timezone);
  const peaks = intervals.filter(({ count }) => count === busiest);
  const showPeak = busiest > 1 && peaks.length < intervals.length;
  const peak = peaks[0]!;
  const courtNameCounts = new Map<string, number>();
  for (const { courtName } of courts) courtNameCounts.set(courtName, (courtNameCounts.get(courtName) ?? 0) + 1);

  return <div className="report-insights">
    <div className="report-insights__section">
    <section className="report-insights__section--starts" aria-labelledby={`${id}-starts`}>
      <header className="report-insights__heading">
        <div>
          <h4 id={`${id}-starts`}>Completed match starts</h4>
          <p className="report-insights__note">{showStartDate && singleDate ? `${singleDate} · ` : ''}{hours % 24 === 0 ? `${hours / 24}-day` : `${hours}-hour`} intervals</p>
        </div>
        {showPeak ? <p className="report-insights__peak">
          <span aria-hidden="true">Peak <strong>{busiest}</strong> · {peaks.length === 1
            ? [peak.date, peak.axisTime, peak.axisOffset].filter(Boolean).join(' ') : `${peaks.length} tied`}</span>
          <span className="sr-only">Peak of {busiest} starts {peaks.length === 1
            ? `in the interval beginning ${[peak.date, peak.time].filter(Boolean).join(', ')}` : `in ${peaks.length} intervals`}.</span>
        </p> : null}
      </header>
      <ol className="report-insights__starts" role="list" aria-label="Starts by interval">
        {intervals.map(({ at, count, date, time, axisTime, axisOffset }) => <li key={at} className="report-insights__interval"
          data-peak={showPeak && count === busiest ? '' : undefined} data-empty={count === 0 ? '' : undefined}>
          <time className="report-insights__axis" dateTime={new Date(at).toISOString()}>
            <span className="report-insights__axis-clock" aria-hidden="true">{axisTime}</span>
            {date ? <span aria-hidden="true">{date}</span> : null}
            {axisOffset ? <span aria-hidden="true">{axisOffset}</span> : null}
            <span className="sr-only">{date ? `${date}, ` : ''}{time}</span>
          </time>
          <div className="report-insights__plot">
            <div className="report-insights__column" style={{ height: `${100 * count / busiest}%` }}>
              <span className="report-insights__start-count">{count}<span className="sr-only"> {count === 1 ? 'start' : 'starts'}</span></span>
            </div>
          </div>
        </li>)}
      </ol>
    </section>
    {children}
    </div>
    <section className="report-insights__section report-insights__section--courts" aria-labelledby={`${id}-courts`}>
      <h4 id={`${id}-courts`}>Completed time by court</h4>
      <div className="report-insights__courts">
        <div className="report-insights__court-guide" aria-hidden="true"><span>Min:sec</span><span>Matches</span></div>
        <ul className="report-insights__court-list" role="list">
          {courts.map(({ courtId, courtName, matches: count, seconds }) => <li
            key={JSON.stringify([courtId, courtName])} className="report-insights__court">
            <span className="report-insights__court-name">{courtName}{courtNameCounts.get(courtName)! > 1
              ? <small> (court {courtId})</small> : null}</span>
            <span className="report-insights__bar" aria-hidden="true">
              <span style={{ width: `${longestCourtTime > 0 ? 100 * seconds / longestCourtTime : 0}%` }} />
            </span>
            <CourtDuration seconds={seconds} />
            <span className="report-insights__court-value">{count}<span className="sr-only"> {count === 1 ? 'match' : 'matches'}</span></span>
          </li>)}
        </ul>
      </div>
    </section>
  </div>;
}
