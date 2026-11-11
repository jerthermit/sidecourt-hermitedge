import React, { useEffect, useRef, useState } from 'react';
import { animate, AnimatePresence, motion } from 'motion/react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Court as CourtType, CourtStatus, GameHistory, Player } from '../types/models';
import { CourtHistory } from './CourtHistory';
import { PlayerCard } from './PlayerCard';
import { ReasonDialog } from './ReasonDialog';
import { animateCourtCommit } from '../lib/courtMotion';
import { interactionEase, useMotionPolicy } from '../lib/interactionMotion';
import { CourtDiagram } from './CourtDiagram';
import { CourtName } from './CourtName';

interface CourtProps {
  court: CourtType;
  history: GameHistory[];
  identityHistory?: GameHistory[];
  disabled?: boolean;
  busy?: boolean;
  playerCount?: number;
  timezone?: string;
  roster?: Player[];
  sessionId?: string;
  sessionOpen?: boolean;
  error?: string | null;
  onClearError?: () => void;
  onVoidGame?: (courtId: number, reason: string) => Promise<boolean>;
  onVoidRecordedGame?: (gameId: string, reason: string) => Promise<boolean>;
  onCorrectRecordedGame?: (gameId: string, correction: { playerIds: string[]; durationSeconds: number; reason: string }) => Promise<boolean>;
  onStartGame: (courtId: number) => Promise<boolean>;
  onEndGame: (courtId: number) => Promise<boolean>;
  onEndAndReview?: (courtId: number) => Promise<boolean>;
  onReviewNext?: (courtId: number) => Promise<boolean>;
  canReviewNext?: boolean;
  reviewMixed?: boolean;
  onToggleStatus: (courtId: number) => Promise<boolean>;
  onSelectPlayer?: ((player: Player) => void) | undefined;
}

const formatElapsed = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
};

const sortableTransform = (
  transform: { x: number; y: number; scaleX: number; scaleY: number } | null,
): string | undefined => {
  if (!transform) return undefined;
  return `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`;
};

export const Court: React.FC<CourtProps> = ({
  court,
  history,
  identityHistory,
  disabled = false,
  busy = false,
  playerCount = 4,
  timezone = 'Australia/Sydney',
  onStartGame,
  onEndGame,
  onEndAndReview, onReviewNext, canReviewNext = false, reviewMixed = false,
  onToggleStatus,
  roster = [], sessionId, sessionOpen = false, error = null, onClearError,
  onVoidGame, onVoidRecordedGame, onCorrectRecordedGame,
  onSelectPlayer,
}) => {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isVoidOpen, setIsVoidOpen] = useState(false);
  const motionPolicy = useMotionPolicy();
  const courtRef = useRef<HTMLElement>(null);
  const playerIds = court.players.map((player) => player.id).join(',');
  const layoutState = `${court.status}:${playerCount}:${playerIds}`;
  const previousState = useRef({ status: court.status, ids: playerIds });
  useEffect(() => {
    const previous = previousState.current;
    const current = { status: court.status, ids: playerIds };
    previousState.current = current;
    const element = courtRef.current;
    if (!element) return;
    const suspended = motionPolicy.reduced || motionPolicy.dragging;
    const stopCommit = animateCourtCommit(element, previous, current, suspended);
    const timer = element.querySelector('.court-timer');
    const timerEntry = !suspended && previous.status !== 'in-play' && current.status === 'in-play' && timer
      ? animate(timer, { opacity: [0.6, 1], y: [-3, 0] }, { duration: 0.26, ease: interactionEase }) : null;
    return () => { stopCommit(); timerEntry?.complete(); };
  }, [court.status, playerIds, motionPolicy.reduced, motionPolicy.dragging]);
  const courtName = court.name ?? `Court ${court.id}`;
  const isReady = court.status === 'available' && court.players.length === playerCount;
  const canAcceptPlayers = court.status === 'available' && court.players.length < playerCount && !disabled;
  const canStartGame = court.status === 'available'
    && court.players.length === playerCount
    && !disabled;
  const isRosterLocked = court.status === 'in-play';
  const runCourtAction = async (trigger: HTMLButtonElement, action: (courtId: number) => Promise<boolean>) => {
    const restoreFocus = document.activeElement === trigger;
    if (await action(court.id) && restoreFocus) window.requestAnimationFrame(() => {
      if (!document.querySelector('dialog[open]') && (document.activeElement === trigger || document.activeElement === document.body)) {
        courtRef.current?.querySelector<HTMLElement>('.court-card__footer .button--primary:not(:disabled), .court-card__footer .button--secondary:not(:disabled)')?.focus({ preventScroll: true });
      }
    });
  };

  const { setNodeRef, isOver } = useDroppable({
    id: `court-${court.id}`,
    disabled: !canAcceptPlayers,
    data: {
      type: 'court',
      courtId: court.id,
      accepts: ['player'],
    },
  });

  return (
    <motion.article ref={courtRef} layout={motionPolicy.layout ? 'position' : false} layoutDependency={layoutState} transition={motionPolicy.transition} initial={false} aria-label={courtName} data-court-id={court.id} tabIndex={-1} data-ready={isReady} data-occupied={court.players.length > 0} className={`court-card court-card--${court.status} ${isOver ? 'drop-surface--active' : ''}`}>
      <header className="court-card__header">
        <div className="court-card__identity">
          <CourtName name={courtName} />
          <StatusBadge status={court.status} ready={isReady} />
        </div>
        <div className="court-card__tools">
          {court.status === 'in-play' ? (
            <time className="court-timer" aria-label={`${court.timeElapsed} seconds elapsed`}>
              {formatElapsed(court.timeElapsed)}
            </time>
          ) : null}
          {history.length > 0 ? (
            <button
              type="button"
              className="icon-button icon-button--small"
              onClick={() => { onClearError?.(); setIsHistoryOpen(true); }}
              aria-label={`View ${courtName} match history`}
              title="Match history"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 19V9m6 10V5m6 14v-7m4 7H2" />
              </svg>
            </button>
          ) : null}
          {court.status !== 'in-play' ? <button
            type="button"
            className="icon-button icon-button--small"
            onClick={() => void onToggleStatus(court.id)}
            disabled={disabled}
            aria-label={court.status === 'disabled' ? `Open ${courtName}` : `Close ${courtName}`}
            title={court.status === 'disabled' ? 'Open court' : 'Close court'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2v10m6.4-5.4a9 9 0 1 1-12.8 0" />
            </svg>
          </button> : null}
        </div>
      </header>

      <div
        ref={setNodeRef}
        className="court-card__roster drop-surface"
        aria-label={`${courtName} roster`}
      >
        <SortableContext items={court.players.map((player) => player.id)} strategy={verticalListSortingStrategy}>
          {court.players.length > 0 ? (
            <motion.div className="court-card__players" layout={motionPolicy.layout ? 'position' : false} layoutDependency={layoutState} transition={motionPolicy.transition}>
              {[0, 1].map((team) => <motion.section className="court-team" key={team} aria-label={`Team ${team + 1}`} layout={motionPolicy.layout ? 'position' : false} layoutDependency={layoutState} transition={motionPolicy.transition}>
                <h4>Team {team + 1}</h4>
                {court.players.slice(team * playerCount / 2, (team + 1) * playerCount / 2).map((player) => <SortableCourtPlayer key={player.id} player={player} layoutState={layoutState} disabled={disabled || isRosterLocked} onSelect={onSelectPlayer} />)}
                {court.players.length <= team * playerCount / 2 ? <span className="court-team__unfilled">Unassigned</span> : null}
              </motion.section>)}
            </motion.div>
          ) : (
            <div className="court-empty" aria-label={court.status === 'disabled' ? 'Court closed' : 'Drag players here to assign'}>
              <CourtDiagram />
              {court.status !== 'disabled' ? <span className="sr-only">No group assigned</span> : null}
            </div>
          )}
        </SortableContext>
      </div>

      <footer className="court-card__footer">
        {court.status === 'in-play' ? (
          <>
            {onVoidGame ? <button type="button" className="button button--ghost button--small" onClick={() => { onClearError?.(); setIsVoidOpen(true); }} disabled={disabled}>Void</button> : <span id={`court-${court.id}-help`} className="court-card__hint">Locked</span>}
            {onEndAndReview ? <button type="button" className="button button--ghost button--small" onClick={(event) => void runCourtAction(event.currentTarget, onEndGame)} disabled={disabled}>End only</button> : null}
            <button
              type="button"
              className="button button--primary button--small"
              onClick={(event) => void runCourtAction(event.currentTarget, onEndAndReview ?? onEndGame)}
              disabled={disabled}
            >
              {onEndAndReview ? 'End & review' : 'End match'}
            </button>
          </>
        ) : court.status === 'disabled' ? null : court.players.length === 0 && onReviewNext ? (
          <>
            <span className="court-card__hint">{court.players.length} / {playerCount}</span>
            <button type="button" className="button button--secondary button--small"
              disabled={disabled || !canReviewNext} onClick={() => void onReviewNext(court.id)}>
              {reviewMixed ? 'Review mixed group' : 'Review group'}
            </button>
          </>
        ) : (
          <>
            <span id={`court-${court.id}-help`} className="court-card__hint">
              {court.players.length} / {playerCount}
            </span>
            <button
              type="button"
              className="button button--primary button--small"
              onClick={(event) => void runCourtAction(event.currentTarget, onStartGame)}
              disabled={!canStartGame}
            >
              Start
            </button>
          </>
        )}
      </footer>

      <AnimatePresence initial={false}>
      {isHistoryOpen ? (
        <CourtHistory key={`court-history-${court.id}`} courtId={court.id} courtName={courtName} history={history} identityHistory={identityHistory} timezone={timezone} onClose={() => { setIsHistoryOpen(false); onClearError?.(); }} roster={roster} sessionId={sessionId} sessionOpen={sessionOpen} busy={busy} error={error} onClearError={onClearError} onVoid={onVoidRecordedGame} onCorrect={onCorrectRecordedGame} />
      ) : null}
      {isVoidOpen && onVoidGame ? <ReasonDialog key={`court-void-${court.id}`} title={`Void ${courtName} match`} message="This match will not count. Players stay on this court." busy={disabled} error={error} onClose={() => { setIsVoidOpen(false); onClearError?.(); }} onConfirm={(reason) => onVoidGame(court.id, reason)} /> : null}
      </AnimatePresence>
    </motion.article>
  );
};

interface SortableCourtPlayerProps {
  player: Player;
  layoutState: string;
  disabled: boolean;
  onSelect?: ((player: Player) => void) | undefined;
}

const SortableCourtPlayer: React.FC<SortableCourtPlayerProps> = ({ player, layoutState, disabled, onSelect }) => {
  const motionPolicy = useMotionPolicy();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: player.id,
    disabled,
    data: { type: 'player', player },
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: sortableTransform(transform), transition }}
      {...attributes}
      {...listeners}
      tabIndex={disabled ? -1 : attributes.tabIndex}
      onClick={() => { if (!disabled && !isDragging) onSelect?.(player); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && onSelect && !disabled) { event.preventDefault(); event.stopPropagation(); onSelect(player); }
        else listeners?.onKeyDown?.(event);
      }}
      className="drag-item"
      data-player-id={player.id}
      aria-label={disabled ? `${player.name}, roster locked` : `Move ${player.name}`}
    >
      <motion.div layout={motionPolicy.layout ? 'position' : false} layoutId={motionPolicy.layout && !isDragging ? `player-${player.id}` : undefined} layoutDependency={layoutState} transition={motionPolicy.transition} initial={false}>
        <PlayerCard player={player} isDragging={isDragging} />
      </motion.div>
    </div>
  );
};

interface StatusBadgeProps {
  status: CourtStatus;
  ready?: boolean;
}

const statusLabels: Record<CourtStatus, string> = {
  available: 'Open',
  'in-play': 'In play',
  disabled: 'Closed',
};

const StatusBadge: React.FC<StatusBadgeProps> = ({ status, ready = false }) => (
  <span className={`status-badge status-badge--${status}${ready ? ' status-badge--ready' : ''}`}>{ready ? 'Ready' : statusLabels[status]}</span>
);
