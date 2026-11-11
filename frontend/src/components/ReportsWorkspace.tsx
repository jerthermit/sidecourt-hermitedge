import { useEffect, useId, useRef, useState } from 'react';
import type { Attendance, DailyReport, Session, SessionReport } from '../types/models';
import { pageWindow } from '../lib/pagination';
import { ListPagination } from './ListPagination';
import { usePageSize } from '../lib/usePageSize';
import { DailyReportContent } from './DailyReportContent';
import { ReportMatchRecords } from './ReportRecords';
import { ReportInsights } from './ReportInsights';
import { ReportDetails, ReportExceptions, ReportMetrics, ReportPlayerCoverage, ReportUpdated } from './ReportOverview';
import { reportDuration as duration, reportTimestamp as timestamp, reportLocalDate } from '../lib/reportFormatting';

interface ReportsWorkspaceProps {
  sessionId: string;
  onLoad: (sessionId: string) => Promise<SessionReport | null>;
  onExport: (kind: 'attendance' | 'matches', sessionId?: string) => Promise<boolean>;
  error: string | null;
  busy: boolean;
  sessions?: Session[];
  timezone?: string;
  onLoadDay?: (date: string) => Promise<DailyReport | null>;
}

const attendanceLabels: Record<Attendance, string> = {
  expected: 'Expected', ready: 'Ready', resting: 'Resting', departed: 'Left',
};

function ParticipantIdentity({ player, duplicateName }: {
  player: SessionReport['participants'][number]; duplicateName: boolean;
}) {
  return <><strong>{player.name}</strong>{player.externalId
    ? <small>{player.source ? `${player.source} / ` : ''}{player.externalId}</small>
    : duplicateName ? <small>{player.id}</small> : null}</>;
}

export function SessionReportContent({ report }: { report: SessionReport }) {
  const { session, displayTimezone: timezone, totals } = report;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const attendancePage = pageWindow(report.participants.length, page, pageSize);
  const participantIds = new Set(report.participants.map((player) => player.id));
  const nameCounts = new Map<string, number>();
  report.participants.forEach((player) => nameCounts.set(player.name, (nameCounts.get(player.name) ?? 0) + 1));
  const playerCoverage = totals.unattributedCompletedMatches === 0
    ? <ReportPlayerCoverage participants={report.participants} /> : null;
  return <div className="session-report-content">
    <div className="session-report-heading">
      <div><h3>{session.name}</h3><span>{session.endedAt === null ? 'Open' : 'Closed'}</span></div>
      <ReportUpdated at={report.generatedAt} timezone={timezone} />
    </div>
    <dl className="session-report-period report-print-only">
      <div><dt>Opened</dt><dd><time dateTime={new Date(session.startedAt).toISOString()}>{timestamp(session.startedAt, timezone)}</time></dd></div>
      {session.endedAt !== null ? <div><dt>Closed</dt><dd><time dateTime={new Date(session.endedAt).toISOString()}>{timestamp(session.endedAt, timezone)}</time></dd></div> : null}
    </dl>
    <ReportMetrics totals={totals} registered={totals.registeredPlayers} active={report.activeMatches} />
    {totals.completedMatches > 0 ? <ReportInsights matches={report.matches} timezone={timezone}>{playerCoverage}</ReportInsights> : playerCoverage}
    <div className="report-drilldown">
    <ReportDetails label="Attendance" count={report.participants.length}>
      {report.participants.length === 0 ? <p className="queue-empty">No attendance records.</p> : <><div className="session-report-table-scroll">
        <table className="session-report-table">
          <caption className="sr-only">Recorded participants and completed play</caption>
          <thead><tr><th scope="col">Player</th><th scope="col">First check-in</th><th scope="col">Attendance</th><th scope="col">Games</th><th scope="col">Playing time</th></tr></thead>
          <tbody>{report.participants.map((player, index) => <tr key={player.id} hidden={index < attendancePage.start || index >= attendancePage.end}>
            <th scope="row"><ParticipantIdentity player={player} duplicateName={(nameCounts.get(player.name) ?? 0) > 1} /></th>
            <td>{player.checkedInAt === null ? '—' : <time dateTime={new Date(player.checkedInAt).toISOString()}>{timestamp(player.checkedInAt, timezone)}</time>}</td>
            <td>{attendanceLabels[player.attendance]}</td>
            <td>{player.gamesPlayed}</td><td>{duration(player.playedSeconds)}</td>
          </tr>)}</tbody>
        </table>
      </div><ol className="session-report-mobile" aria-label="Recorded participants and completed play">
        {report.participants.map((player, index) => <li key={player.id} hidden={index < attendancePage.start || index >= attendancePage.end}>
          <div className="session-report-mobile__identity"><ParticipantIdentity player={player} duplicateName={(nameCounts.get(player.name) ?? 0) > 1} /></div>
          <dl>
            <div><dt>First check-in</dt><dd>{player.checkedInAt === null ? '—' : <time dateTime={new Date(player.checkedInAt).toISOString()}>{timestamp(player.checkedInAt, timezone)}</time>}</dd></div>
            <div><dt>Attendance</dt><dd>{attendanceLabels[player.attendance]}</dd></div>
            <div><dt>Games</dt><dd>{player.gamesPlayed}</dd></div>
            <div><dt>Playing time</dt><dd>{duration(player.playedSeconds)}</dd></div>
          </dl>
        </li>)}
      </ol>{report.participants.length > 6 ? <ListPagination label="Attendance" {...attendancePage}
        total={report.participants.length} pageSize={pageSize} onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} /> : null}</>}
    </ReportDetails>
    <ReportDetails label="Matches" count={report.matches.length}>
      <ReportExceptions totals={totals} />
      {totals.unattributedCompletedMatches > 0 ? <p className="session-report-note">{totals.unattributedCompletedMatches} completed {totals.unattributedCompletedMatches === 1 ? 'match has' : 'matches have'} incomplete player identities.</p> : null}
      <ReportMatchRecords matches={report.matches} timezone={timezone} participantIds={participantIds} />
    </ReportDetails>
    </div>
  </div>;
}

type ReportResult = { key: string; report: SessionReport | DailyReport | null; error: string | null };

export function ReportsWorkspace({ sessionId, onLoad, onExport, error, busy,
  sessions, timezone = 'Australia/Sydney', onLoadDay }: ReportsWorkspaceProps) {
  const titleId = useId();
  const exportMenuRef = useRef<HTMLDetailsElement>(null);
  const loaderRef = useRef(onLoad);
  const dayLoaderRef = useRef(onLoadDay);
  const errorRef = useRef(error);
  const [mode, setMode] = useState<'session' | 'day'>('session');
  const [selectedSessionId, setSelectedSessionId] = useState(sessionId);
  const [selectedDate, setSelectedDate] = useState(() => reportLocalDate(timezone));
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [exportKey, setExportKey] = useState<string | null>(null);
  const [exportFailure, setExportFailure] = useState<{ key: string; message: string } | null>(null);
  const key = `${mode}:${mode === 'session' ? selectedSessionId : selectedDate}:${revision}`;
  const loaded = result?.key === key;
  const report = loaded ? result.report : null;
  const loading = !loaded;
  const sessionReport = mode === 'session' && report && 'session' in report ? report : null;
  const dailyReport = mode === 'day' && report && 'date' in report ? report : null;
  const reportError = loaded ? result.error : null;
  const actionError = report && exportKey === key && exportFailure?.key === key ? exportFailure.message : null;
  const availableSessions = sessions?.filter((session, index, all) => all.findIndex((entry) => entry.id === session.id) === index);

  useEffect(() => { loaderRef.current = onLoad; }, [onLoad]);
  useEffect(() => { dayLoaderRef.current = onLoadDay; }, [onLoadDay]);
  useEffect(() => { errorRef.current = error; }, [error]);
  useEffect(() => { setSelectedSessionId(sessionId); }, [sessionId]);
  useEffect(() => {
    let disposed = false;
    const request = Promise.resolve().then<SessionReport | DailyReport | null>(() => mode === 'session' ? loaderRef.current(selectedSessionId)
      : dayLoaderRef.current?.(selectedDate) ?? null);
    void request.then((next) => {
      if (disposed) return;
      const matchesSelection = next && (mode === 'session'
        ? 'session' in next && next.session.id === selectedSessionId
        : 'date' in next && next.date === selectedDate);
      setResult({ key, report: matchesSelection ? next : null,
        error: matchesSelection ? null : next ? null : errorRef.current });
    }).catch((failure: unknown) => {
      if (!disposed) setResult({ key, report: null, error: failure instanceof Error ? failure.message : null });
    });
    return () => { disposed = true; };
  }, [mode, selectedSessionId, selectedDate, key]);
  const clearExportError = () => { setExportKey(null); setExportFailure(null); };
  const selectSession = (id: string) => { clearExportError(); setSelectedSessionId(id); setMode('session'); };
  const selectMode = (next: 'session' | 'day') => { clearExportError(); setMode(next); };
  const closeExportMenu = () => {
    const menu = exportMenuRef.current;
    if (!menu?.open) return;
    menu.querySelector('summary')?.focus();
    menu.open = false;
  };
  const exportReport = async (kind: 'attendance' | 'matches') => {
    if (!sessionReport || busy) return;
    closeExportMenu();
    setExportKey(key); setExportFailure(null);
    try {
      if (!await onExport(kind, selectedSessionId)) setExportFailure({ key, message: 'Export failed. Try again.' });
    }
    catch (failure: unknown) { setExportFailure({ key, message: failure instanceof Error ? failure.message : 'Unable to export this report.' }); }
  };
  return <section className="reports-workspace" aria-labelledby={titleId}>
    <header className="reports-workspace__heading">
      <h2 id={titleId}>Reports</h2>
      <div className="session-report-actions">
        <button type="button" className="button button--ghost button--small" disabled={busy || !report} onClick={() => { clearExportError(); setRevision((value) => value + 1); }}>Refresh</button>
        <details ref={exportMenuRef} className="report-export" onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
        }} onKeyDown={(event) => {
          if (event.key === 'Escape' && event.currentTarget.open) { event.preventDefault(); closeExportMenu(); }
        }}>
          <summary className="button button--secondary button--small">Export</summary>
          <div className="report-export__options">
            {mode === 'session' ? <><button type="button" className="button button--ghost" disabled={busy || !sessionReport} onClick={() => void exportReport('attendance')}>Attendance CSV</button>
              <button type="button" className="button button--ghost" disabled={busy || !sessionReport} onClick={() => void exportReport('matches')}>Matches CSV</button></> : null}
            <button type="button" className="button button--ghost" disabled={busy || !report} onClick={() => { closeExportMenu(); window.print(); }}>Print report</button>
          </div>
        </details>
      </div>
    </header>
    <div className="report-controls">
      {onLoadDay ? <div className="report-tabs" role="tablist" aria-label="Report period">
        {(['session', 'day'] as const).map((tab) => <button type="button" key={tab} role="tab"
          id={`${titleId}-${tab}-tab`} aria-controls={`${titleId}-panel`} aria-selected={mode === tab}
          tabIndex={mode === tab ? 0 : -1} onClick={() => selectMode(tab)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'session' : event.key === 'End' ? 'day' : tab === 'session' ? 'day' : 'session';
            selectMode(next);
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${titleId}-${next}-tab`)}`)?.focus();
          }}>{tab === 'session' ? 'Session' : 'Day'}</button>)}
      </div> : null}
      {mode === 'session' && availableSessions?.length ? <label className="report-period-field"><span className="sr-only">Saved session</span>
        <select value={selectedSessionId} onChange={(event) => selectSession(event.target.value)}>
          {!availableSessions.some((session) => session.id === selectedSessionId) ? <option value={selectedSessionId}>Selected session</option> : null}
          {availableSessions.map((session) => <option key={session.id} value={session.id}>{session.name} — {new Intl.DateTimeFormat('en-AU', { timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric' }).format(session.startedAt)}</option>)}
        </select></label> : null}
      {mode === 'day' ? <label className="report-period-field"><span className="sr-only">Date</span><input type="date" value={selectedDate}
        onChange={(event) => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) { clearExportError(); setSelectedDate(event.target.value); } }} /></label> : null}
    </div>
    <div className="session-report-body">
      <div id={`${titleId}-panel`} role={onLoadDay ? 'tabpanel' : undefined} aria-labelledby={onLoadDay ? `${titleId}-${mode}-tab` : undefined}>
        {loading ? <div className="session-report-loading" role="status"><span className="spinner" aria-hidden="true" />Loading report…</div>
          : sessionReport ? <SessionReportContent key={key} report={sessionReport} />
            : dailyReport ? <DailyReportContent key={key} report={dailyReport} onSelectSession={selectSession} />
              : <div className="inline-alert inline-alert--error" role="alert"><span>{reportError || `Unable to load this ${mode === 'day' ? 'day' : 'session'} report.`}</span><button type="button" className="button button--secondary" disabled={busy} onClick={() => setRevision((value) => value + 1)}>Retry</button></div>}
        {actionError ? <div className="inline-alert inline-alert--error" role="alert">{actionError}</div> : null}
      </div>
    </div>
  </section>;
}
