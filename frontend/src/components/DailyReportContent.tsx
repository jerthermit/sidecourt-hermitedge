import type { DailyReport } from '../types/models';
import { ReportMatchRecords } from './ReportRecords';
import { ReportInsights } from './ReportInsights';
import { ReportDetails, ReportExceptions, ReportMetrics, ReportUpdated } from './ReportOverview';
import { reportTimestamp } from '../lib/reportFormatting';

export function DailyReportContent({ report, onSelectSession }: {
  report: DailyReport; onSelectSession: (sessionId: string) => void;
}) {
  const { totals, displayTimezone: timezone } = report;
  const day = new Intl.DateTimeFormat('en-AU', { dateStyle: 'long', timeZone: 'UTC' })
    .format(Date.parse(`${report.date}T12:00:00Z`));
  const empty = report.sessions.length === 0 && report.matches.length === 0 && totals.checkedInPlayers === 0;
  return <div className="session-report-content daily-report-content">
    <div className="session-report-heading"><h3><time dateTime={report.date}>{day}</time></h3>
      <ReportUpdated at={report.generatedAt} timezone={timezone} />
    </div>
    {empty ? <p className="queue-empty">No recorded activity for this date.</p> : <>
    <ReportMetrics totals={totals} />
    {totals.completedMatches > 0 ? <ReportInsights matches={report.matches} timezone={timezone} showStartDate={false} /> : null}
    <div className="report-drilldown">
    <ReportDetails label="Sessions" count={report.sessions.length}>
      {report.sessions.length === 0 ? <p className="queue-empty">No sessions recorded for this day.</p>
        : <ul className="daily-report-sessions">{report.sessions.map((session) => <li key={session.id}>
          <button type="button" className="button button--ghost" onClick={() => onSelectSession(session.id)}>{session.name}</button>
          <span className="daily-report-session-print">{session.name}</span>
          <time dateTime={new Date(session.startedAt).toISOString()}>{reportTimestamp(session.startedAt, timezone)}</time>
        </li>)}</ul>}
    </ReportDetails>
    <ReportDetails label="Matches" count={report.matches.length}>
      <ReportExceptions totals={totals} />
      <ReportMatchRecords matches={report.matches} timezone={timezone} />
    </ReportDetails>
    </div>
    </>}
  </div>;
}
