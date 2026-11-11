import React, { useEffect, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import type { Player, Rotation } from '../types/models';
import { PlayerCard } from './PlayerCard';
import { formatWait } from '../lib/board';
import { pageWindow } from '../lib/pagination';
import { ListPagination } from './ListPagination';
import { usePageSize } from '../lib/usePageSize';
import { motion, useIsPresent } from 'motion/react';
import { useMotionPolicy } from '../lib/interactionMotion';

interface HoldingPoolProps {
  players: Player[];
  disabled?: boolean;
  isProposalLoading?: boolean;
  onSuggestMatch: (allowMixed?: boolean) => void;
  playerCount?: number;
  rotation?: Rotation;
  onReviewRotation?: (() => void) | undefined;
  rotationAvailable?: boolean;
  showReviewAction?: boolean;
  showCount?: boolean;
  paginationLocked?: boolean;
  onSelectPlayer?: ((player: Player) => void) | undefined;
}

const sortableTransform = (
  transform: { x: number; y: number; scaleX: number; scaleY: number } | null,
): string | undefined => {
  if (!transform) return undefined;
  return `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`;
};

export const HoldingPool: React.FC<HoldingPoolProps> = ({
  players,
  disabled = false,
  isProposalLoading = false,
  onSuggestMatch,
  playerCount = 4,
  rotation,
  onReviewRotation,
  rotationAvailable = true,
  showReviewAction = true,
  showCount = true,
  paginationLocked = false,
  onSelectPlayer,
}) => {
  const { setNodeRef, isOver } = useDroppable({
    id: 'holding-pool',
    disabled,
    data: { type: 'holding-pool', accepts: ['player'] },
  });

  const [now, setNow] = useState(Date.now);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(true);
  const query = search.trim().toLocaleLowerCase();
  const filtered = players.map((player, index) => ({ player, index }))
    .filter(({ player }) => !query || player.name.toLocaleLowerCase().includes(query));
  const pagination = pageWindow(filtered.length, page, pageSize);
  // Commit the clamp so a later arrival cannot reopen a previously empty page.
  if (page !== pagination.page) setPage(pagination.page);
  const visible = filtered.slice(pagination.start, pagination.end);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const incompleteBand = rotation !== undefined && rotation.missingPlayers > 0 && rotation.waitingBand !== null;
  const needsMixed = incompleteBand && rotation.needsMixedApproval;
  const canSuggest = players.length >= playerCount && !disabled && !isProposalLoading
    && (onReviewRotation ? rotationAvailable : (!incompleteBand || needsMixed));

  return (
    <section className="holding-pool" aria-labelledby="holding-pool-title">
      <div className="section-heading section-heading--compact">
        <div className="queue-title">
          <h2 id="holding-pool-title" className="section-title">Waiting</h2>
          {showCount ? <span className="count-badge" aria-label={`${players.length} players waiting`}>
            {players.length}
          </span> : null}
        </div>
        {showReviewAction ? <button
            type="button"
            className="button button--primary button--small"
            onClick={() => onReviewRotation ? onReviewRotation() : onSuggestMatch(needsMixed)}
            disabled={!canSuggest}
            aria-describedby="suggest-match-help"
          >
            {isProposalLoading ? <span className="spinner spinner--small" aria-hidden="true" /> : null}
            {isProposalLoading ? 'Preparing teams…' : onReviewRotation ? 'Review rotation' : needsMixed ? 'Review mixed group' : 'Review match'}
          </button> : null}
      </div>
      {showReviewAction ? <p id="suggest-match-help" className="sr-only">
        {onReviewRotation ? 'Reviews waiting players across empty courts.' : `Reviews the next ${playerCount} waiting players.`} Players move only after approval.
      </p> : null}
      {incompleteBand ? <p className="queue-policy" role="status">Waiting for {rotation.missingPlayers} {rotation.waitingBand} {rotation.missingPlayers === 1 ? 'player' : 'players'}</p> : null}

      {players.length > 0 ? <label className="queue-search">
        <span className="sr-only">Search waiting players</span>
        <input type="search" placeholder="Find a waiting player" value={search} disabled={paginationLocked}
          onChange={event => { setSearch(event.target.value); setPage(1); }} />
      </label> : null}

      <div
        ref={setNodeRef}
        className={`holding-pool__list drop-surface ${isOver ? 'drop-surface--active' : ''}`}
        aria-label="Check-in queue drop area"
      >
        <QueuePage key={`${pagination.page}-${pageSize}-${query}`}>
        <SortableContext items={visible.map(({ player }) => player.id)} strategy={rectSortingStrategy}>
          {visible.length > 0 ? (
            <div className="player-list">
              {visible.map(({ player, index }) => (
                <SortablePoolItem key={player.id} player={player} disabled={disabled} disableSort={Boolean(query)} index={index} now={now} onSelect={onSelectPlayer} />
              ))}
            </div>
          ) : (
            <div className="empty-state empty-state--compact">
              <p>{players.length === 0 ? 'No players waiting' : 'No matching players'}</p>
              {query ? <button type="button" className="button button--ghost" disabled={paginationLocked}
                onClick={() => { setSearch(''); setPage(1); }}>Clear search</button> : null}
            </div>
          )}
        </SortableContext>
        </QueuePage>
      </div>
      {players.length > 0 ? <ListPagination label="Waiting" {...pagination} total={filtered.length} pageSize={pageSize}
        disabled={paginationLocked} onPageChange={setPage}
        onPageSizeChange={size => { setPageSize(size); setPage(1); }} /> : null}
    </section>
  );
};

function QueuePage({ children }: { children: React.ReactNode }) {
  const present = useIsPresent();
  const policy = useMotionPolicy();
  return <motion.div className="queue-page" inert={!present}
    initial={policy.reduced || policy.dragging ? false : { opacity: 0, y: 6 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: policy.layout ? -4 : 0, transition: { duration: policy.layout ? 0.1 : 0 } }}
    transition={policy.transition}>{children}</motion.div>;
}

interface SortablePoolItemProps {
  player: Player;
  disabled: boolean;
  disableSort: boolean;
  index: number;
  now: number;
  onSelect?: ((player: Player) => void) | undefined;
}

const SortablePoolItem: React.FC<SortablePoolItemProps> = ({ player, disabled, disableSort, index, now, onSelect }) => {
  const present = useIsPresent();
  const policy = useMotionPolicy();
  const unavailable = disabled || !present;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: player.id,
    disabled: unavailable || disableSort,
    data: { type: 'player', player },
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: sortableTransform(transform), transition }}
      {...attributes}
      {...(disableSort ? {} : listeners)}
      aria-disabled={unavailable}
      aria-roledescription={disableSort ? undefined : attributes['aria-roledescription']}
      aria-describedby={disableSort ? undefined : attributes['aria-describedby']}
      onClick={() => { if (!unavailable && !isDragging) onSelect?.(player); }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || (disableSort && event.key === ' ')) && onSelect && !unavailable) { event.preventDefault(); event.stopPropagation(); onSelect(player); }
        else if (!disableSort && !unavailable) listeners?.onKeyDown?.(event);
      }}
      className="drag-item waiting-player-motion"
      data-player-id={player.id}
      aria-label={`Move ${player.name}`}
    >
      <motion.div className="waiting-player" layout={policy.layout ? 'position' : false}
        layoutDependency={`${player.id}-${index}`} transition={policy.transition}>
      <span className="waiting-player__position" aria-label={`Queue position ${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>
      <div className="waiting-player__body"><motion.div className="waiting-player__identity" layout={policy.layout ? 'position' : false}
        layoutDependency={`${player.id}-${index}`}
        layoutId={policy.layout && present ? `player-${player.id}` : undefined} transition={policy.transition}>
        <PlayerCard player={player} isDragging={isDragging} showLevel={false} />
      </motion.div><span className="waiting-player__ledger"><span aria-label="Current wait">{formatWait(player.waitingSince, now)} wait</span><span>{player.gamesPlayed ?? '—'} {player.gamesPlayed === 1 ? 'game' : 'games'}</span></span></div>
      </motion.div>
    </div>
  );
};
