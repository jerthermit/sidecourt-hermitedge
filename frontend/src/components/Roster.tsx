import { useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { pageWindow } from '../lib/pagination';
import type { Attendance, Court, Player } from '../types/models';
import { ListPagination } from './ListPagination';
import { usePageSize } from '../lib/usePageSize';
import { RemovePlayerDialog } from './RemovePlayerDialog';
import { RosterRows } from './RosterRows';

type RosterFilter = Attendance | 'all' | 'playing';

interface RosterProps {
  players: Player[];
  courts: Court[];
  disabled: boolean;
  paginationLocked?: boolean;
  onImport: (trigger: HTMLButtonElement) => void;
  onAttendance: (id: string, attendance: Attendance) => Promise<boolean>;
  onRemove?: (id: string) => Promise<boolean>;
  error?: string | null;
  onClearError?: () => void;
}

const filters: Array<{ value: RosterFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'expected', label: 'Expected' },
  { value: 'ready', label: 'Ready' },
  { value: 'playing', label: 'Playing' },
  { value: 'resting', label: 'Resting' },
  { value: 'departed', label: 'Left' },
];

export function Roster({ players, courts, disabled, paginationLocked = false, onImport, onAttendance, onRemove,
  error = null, onClearError }: RosterProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<RosterFilter>('all');
  const [requestedPage, setRequestedPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize();
  const [removal, setRemoval] = useState<{ player: Player; trigger: HTMLButtonElement } | null>(null);
  const playingCourts = new Map(
    courts.filter((court) => court.status === 'in-play')
      .flatMap((court) => court.players.map((player) => [player.id, court.id] as const)),
  );
  const statusOf = (player: Player): Exclude<RosterFilter, 'all'> =>
    playingCourts.has(player.id) ? 'playing' : player.attendance;
  const query = search.trim().toLocaleLowerCase();
  const filtered = players.filter((player) =>
    (filter === 'all' || statusOf(player) === filter)
    && (!query || `${player.name} ${player.externalId ?? ''} ${player.source ?? ''}`.toLocaleLowerCase().includes(query)),
  );
  const pagination = pageWindow(filtered.length, requestedPage, pageSize);
  if (requestedPage !== pagination.page) setRequestedPage(pagination.page);
  const visible = filtered.slice(pagination.start, pagination.end);

  const removalPlayer = removal ? players.find((player) => player.id === removal.player.id) ?? removal.player : null;
  const removalMissing = removal !== null && !players.some((player) => player.id === removal.player.id);
  const removalBlockedReason = removalPlayer && playingCourts.has(removalPlayer.id)
    ? 'End the active match before removing this player.'
    : removalMissing ? 'Player is no longer in the roster.' : null;
  const closeRemoval = () => {
    setRemoval(null);
    onClearError?.();
  };

  return <>
    <section className="roster-view" aria-labelledby="roster-title">
      <div className="roster-view__heading">
        <h2 id="roster-title">Roster</h2>
        <button type="button" className="button button--primary" onClick={(event) => onImport(event.currentTarget)} disabled={disabled}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5" /></svg>
          Import roster CSV
        </button>
      </div>

      <div className="roster-toolbar">
        <div className="roster-filters" role="group" aria-label="Attendance filter">
          {filters.map((item) => (
            <button key={item.value} type="button" aria-pressed={filter === item.value} disabled={paginationLocked}
              onClick={() => { setFilter(item.value); setRequestedPage(1); }}>
              {item.label}<span>{item.value === 'all' ? players.length : players.filter((player) => statusOf(player) === item.value).length}</span>
            </button>
          ))}
        </div>
        <label className="roster-search"><span className="sr-only">Search roster</span>
          <input type="search" placeholder="Search players" value={search} disabled={paginationLocked}
            onChange={(event) => { setSearch(event.target.value); setRequestedPage(1); }} />
        </label>
      </div>

      <div className="roster-table-scroll">
        <table className="roster-table">
          <caption className="sr-only">Player attendance and session readiness</caption>
          <thead><tr><th scope="col">Player</th><th scope="col">Level</th><th scope="col">Local rating</th><th scope="col">Games</th><th scope="col">State</th><th scope="col"><span className="sr-only">Attendance actions</span></th></tr></thead>
          <AnimatePresence initial={false} mode="wait">
            <RosterRows key={JSON.stringify([pagination.page, pageSize, query, filter])}
              players={visible} courts={courts} playingCourts={playingCourts} disabled={disabled}
              onAttendance={onAttendance} onRequestRemove={onRemove ? (player, trigger) => {
                onClearError?.();
                setRemoval({ player, trigger });
              } : undefined} />
          </AnimatePresence>
        </table>
        {filtered.length === 0 ? (
          <div className="roster-empty" role="status">
            <h3>{players.length === 0 ? 'No players yet' : 'No matching players'}</h3>
            {players.length > 0 ? <button type="button" className="button button--ghost" disabled={paginationLocked} onClick={() => { setSearch(''); setFilter('all'); setRequestedPage(1); }}>Clear filters</button> : null}
          </div>
        ) : null}
      </div>
      <footer className="roster-view__footer">
        <ListPagination label="Roster" {...pagination} total={filtered.length} pageSize={pageSize} disabled={paginationLocked}
          onPageChange={setRequestedPage} onPageSizeChange={(size) => { setPageSize(size); setRequestedPage(1); }} />
      </footer>
    </section>
    <AnimatePresence>
    {removal && removalPlayer && onRemove ? <RemovePlayerDialog key={removalPlayer.id} player={removalPlayer} busy={disabled} error={error}
      blockedReason={removalBlockedReason} returnFocusTo={removal.trigger}
      onRemove={onRemove} onClose={closeRemoval} /> : null}
    </AnimatePresence>
  </>;
}
