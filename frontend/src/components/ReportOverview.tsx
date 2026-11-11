import { useId, useState, type ReactNode } from 'react';
import type { DailyReport, SessionReport } from '../types/models';
import { reportDuration, reportTimestamp } from '../lib/reportFormatting';

export function ReportMetrics({ totals, registered, active }: {
  totals: DailyReport['totals']; registered?: number; active?: number;
}) {
  return <dl className="report-metrics">
    <div>
      <dt>Checked in</dt>
      <dd><strong>{totals.checkedInPlayers}</strong>{registered !== undefined ? <small> / {registered}</small> : null}
        {registered !== undefined && registered > 0 ? <span className="report-metrics__track" aria-hidden="true">
          <span style={{ width: `${Math.min(100, 100 * totals.checkedInPlayers / registered)}%` }} />
        </span> : null}
      </dd>
    </div>
    <div>
      <dt>Completed matches</dt>
      <dd><strong>{totals.completedMatches}</strong>{active ? <small> {active} in play</small> : null}</dd>
    </div>
    <div>
      <dt>Completed court time</dt>
      <dd><strong>{reportDuration(totals.completedCourtSeconds)}</strong></dd>
    </div>
  </dl>;
}

const gameBands = ['0', '1', '2', '3', '4+'];

export function ReportPlayerCoverage({ participants }: { participants: SessionReport['participants'] }) {
  const id = useId();
  const counts = [0, 0, 0, 0, 0];
  let checkedIn = 0;
  for (const player of participants) {
    if (player.checkedInAt === null) continue;
    const band = Math.min(4, player.gamesPlayed);
    counts[band] = counts[band]! + 1;
    checkedIn++;
  }
  if (!checkedIn) return null;
  return <section className="report-coverage" aria-labelledby={id}>
    <div className="report-coverage__heading">
      <h4 id={id}>Completed games per player</h4>
      <span>Checked-in players</span>
    </div>
    <div className="report-coverage__bar" aria-hidden="true">
      {counts.map((count, index) => count > 0 ? <span key={index} data-band={index}
        style={{ flexGrow: count }} /> : null)}
    </div>
    <ul className="report-coverage__legend">
      {counts.map((count, index) => <li key={index} data-band={index}>
        <span>{gameBands[index]} {index === 1 ? 'game' : 'games'}</span>
        <strong>{count}<span className="sr-only"> {count === 1 ? 'player' : 'players'}</span></strong>
      </li>)}
    </ul>
  </section>;
}

export function ReportUpdated({ at, timezone }: { at: number; timezone: string }) {
  const full = reportTimestamp(at, timezone);
  return <p className="session-report-time">Updated <time dateTime={new Date(at).toISOString()} title={full}>
    <span className="report-screen-only">{new Intl.DateTimeFormat('en-AU', { timeZone: timezone, timeStyle: 'short' }).format(at)}</span>
    <span className="report-print-only">{full} ({timezone})</span>
  </time></p>;
}

export function ReportDetails({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <section className="report-details" aria-label={label}>
    <h4>
      <button type="button" aria-controls={id} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{label} <small>{count}</small></span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
      </button>
      <span className="report-print-only">{label}</span>
    </h4>
    <div id={id} className="report-details__content" hidden={!open}>{children}</div>
  </section>;
}

export function ReportExceptions({ totals }: { totals: DailyReport['totals'] }) {
  const notes = [
    totals.voidedMatches ? `${totals.voidedMatches} voided` : '',
    totals.correctedMatches ? `${totals.correctedMatches} corrected` : '',
  ].filter(Boolean);
  return notes.length ? <p className="session-report-note">{notes.join(' · ')}</p> : null;
}
