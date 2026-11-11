import { useState } from 'react';
import type { GameHistory } from '../types/models';
import { pageWindow } from '../lib/pagination';
import { ListPagination } from './ListPagination';
import { reportDuration, reportTimestamp } from '../lib/reportFormatting';

export function ReportMatchRecords({ matches, timezone, participantIds }: {
  matches: GameHistory[]; timezone: string; participantIds?: Set<string>;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(6);
  const window = pageWindow(matches.length, page, pageSize);
  return matches.length === 0 ? <p className="queue-empty">No recorded matches.</p> : <>
    <ol className="match-records report-records">
      {matches.map((game, index) => {
        const identitiesRecorded = game.playerIds?.length === game.players.length
          && (game.playerIds.length === 2 || game.playerIds.length === 4)
          && game.playerIds.every((id) => !participantIds || participantIds.has(id))
          && new Set(game.playerIds).size === game.playerIds.length;
        return <li key={game.id} hidden={index < window.start || index >= window.end}
          className={`match-record ${game.status === 'voided' ? 'match-record--voided' : ''}`}>
          <div className="match-record__meta">
            <strong>{game.courtName ?? `Court ${game.courtId}`}</strong>
            <time dateTime={new Date(game.startedAt).toISOString()}>{reportTimestamp(game.startedAt, timezone)}</time>
            <span>{reportDuration(game.duration)}</span>
            <span className={`record-status record-status--${game.status ?? 'completed'}`}>{game.status === 'voided' ? 'Voided' : game.correctedAt != null ? 'Corrected' : 'Completed'}</span>
          </div>
          {identitiesRecorded ? <div className="session-report-teams">
            {[0, 1].map((team) => <p className="match-record__names" key={team}><span>Team {team + 1}</span>{game.players.slice(team * game.players.length / 2, (team + 1) * game.players.length / 2).join(', ')}</p>)}
          </div> : <p className="match-record__names">{game.players.join(', ')}</p>}
          {game.reason ? <p className="match-record__reason">{game.reason}</p> : null}
          {game.correctedAt != null ? <p className="session-report-note">Updated <time dateTime={new Date(game.correctedAt).toISOString()}>{reportTimestamp(game.correctedAt, timezone)}</time></p> : null}
          {!identitiesRecorded ? <p className="session-report-note">Player identities incomplete.</p> : null}
        </li>;
      })}
    </ol>
    {matches.length > 6 ? <ListPagination label="Recorded matches" {...window} total={matches.length} pageSize={pageSize}
      onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} /> : null}
  </>;
}
