import React from 'react';
import { motion } from 'motion/react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { NextGamePool as NextGamePoolType, Player, QueueLane } from '../types/models';
import { PlayerCard } from './PlayerCard';
import { useMotionPolicy } from '../lib/interactionMotion';

interface NextGamePoolProps {
  nextGamePool: NextGamePoolType;
  disabled?: boolean;
  onSelectPlayer?: ((player: Player) => void) | undefined;
  playerCount?: number;
  onAssignGroup?: (lane: QueueLane) => void;
}

interface PoolSectionProps {
  title: string;
  players: Player[];
  lane: QueueLane;
  disabled: boolean;
  onSelectPlayer?: ((player: Player) => void) | undefined;
  playerCount: number;
  onAssignGroup?: (lane: QueueLane) => void;
}

const PoolSection: React.FC<PoolSectionProps> = ({ title, players, lane, disabled, onSelectPlayer, playerCount, onAssignGroup }) => {
  const motionPolicy = useMotionPolicy();
  const playerIds = players.map((player) => player.id).join(',');
  const { setNodeRef, isOver } = useDroppable({
    id: `next-game-${lane}`,
    disabled,
    data: { type: 'next-game-pool', poolType: lane },
  });

  return (
    <motion.section ref={setNodeRef} layout={motionPolicy.layout ? 'position' : false} layoutDependency={playerIds} transition={motionPolicy.transition} initial={false} className={`queue-lane queue-lane--${lane} ${isOver ? 'drop-surface--active' : ''}`} aria-labelledby={players.length ? `lane-${lane}` : undefined} aria-label={players.length ? undefined : `${title} staging`}>
      {players.length > 0 ? <motion.div className="queue-lane__heading" layout={motionPolicy.layout ? 'position' : false} layoutDependency={playerIds} transition={motionPolicy.transition}>
        <h3 id={`lane-${lane}`}>{title}</h3>
        <span aria-label={`${players.length} players`}>{players.length}</span>
      </motion.div> : null}
      <motion.div
        className="queue-lane__drop"
        aria-label={`${title} next-game queue drop area`}
        layout={motionPolicy.layout ? 'position' : false} layoutDependency={playerIds} transition={motionPolicy.transition}
      >
        <SortableContext items={players.map((player) => player.id)} strategy={verticalListSortingStrategy}>
          {players.length > 0 ? (
            <motion.div className="queue-lane__players" layout={motionPolicy.layout ? 'position' : false} layoutDependency={playerIds} transition={motionPolicy.transition}>
              {players.map((player) => (
                <DraggablePoolItem key={player.id} player={player} layoutState={playerIds} disabled={disabled} onSelect={onSelectPlayer} />
              ))}
            </motion.div>
          ) : (
            <p className="queue-empty">No group staged</p>
          )}
        </SortableContext>
      </motion.div>
      {players.length >= playerCount && onAssignGroup ? <motion.button key="assign-group" type="button"
        className="button button--secondary button--small staged-group-action" disabled={disabled}
        layout={motionPolicy.layout ? 'position' : false} layoutDependency={playerIds} transition={motionPolicy.transition} initial={false}
        onClick={() => onAssignGroup(lane)}>Assign group</motion.button> : null}
    </motion.section>
  );
};

interface DraggablePoolItemProps {
  player: Player;
  layoutState: string;
  disabled: boolean;
  onSelect?: ((player: Player) => void) | undefined;
}

const DraggablePoolItem: React.FC<DraggablePoolItemProps> = ({ player, layoutState, disabled, onSelect }) => {
  const motionPolicy = useMotionPolicy();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: player.id,
    disabled,
    data: { type: 'player', player },
  });

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => { if (!disabled && !isDragging) onSelect?.(player); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && onSelect && !disabled) { event.preventDefault(); event.stopPropagation(); onSelect(player); }
        else listeners?.onKeyDown?.(event);
      }}
      className="drag-item"
      data-player-id={player.id}
      aria-label={`Move ${player.name}`}
    >
      <motion.div layout={motionPolicy.layout ? 'position' : false} layoutId={motionPolicy.layout && !isDragging ? `player-${player.id}` : undefined} layoutDependency={layoutState} transition={motionPolicy.transition} initial={false}>
        <PlayerCard player={player} isDragging={isDragging} showLevel={false} />
      </motion.div>
    </div>
  );
};

export const NextGamePool: React.FC<NextGamePoolProps> = ({ nextGamePool, disabled = false, onSelectPlayer, playerCount = 4, onAssignGroup }) => {
  const motionPolicy = useMotionPolicy();
  const lanes: Array<{ lane: QueueLane; title: string; players: Player[] }> = [
    { lane: 'beginner', title: 'Beginner', players: nextGamePool.beginner },
    { lane: 'intermediate', title: 'Intermediate', players: nextGamePool.intermediate },
    { lane: 'advanced', title: 'Advanced', players: nextGamePool.advanced },
    { lane: 'mixed', title: 'Open group', players: nextGamePool.mixed ?? [] },
  ];
  const occupied = lanes.filter((item) => item.players.length > 0);
  const stagedCount = lanes.reduce((sum, lane) => sum + lane.players.length, 0);
  const layoutState = lanes.map(({ lane, players }) => `${lane}:${players.map((player) => player.id).join(',')}`).join('|');
  return (
    <motion.section className="next-game-pool" data-empty={stagedCount === 0} aria-labelledby="next-game-title" layout={motionPolicy.layout ? 'position' : false} layoutDependency={layoutState} transition={motionPolicy.transition} initial={false}>
      <motion.div className="section-heading section-heading--compact" layout={motionPolicy.layout ? 'position' : false} layoutDependency={layoutState} transition={motionPolicy.transition}>
        <div className="queue-title">
          <h2 id="next-game-title" className="section-title" tabIndex={-1}>Next game</h2>
          {stagedCount > 0 ? <span className="count-badge" aria-label={`${stagedCount} players staged`}>{stagedCount}</span> : null}
        </div>
      </motion.div>

      <motion.div className="next-game-pool__lanes" layout={motionPolicy.layout ? 'position' : false} layoutDependency={layoutState} transition={motionPolicy.transition}>
        {(occupied.length ? occupied : [lanes[3]]).map((item) => <PoolSection key={item.lane} {...item} disabled={disabled} onSelectPlayer={onSelectPlayer} playerCount={playerCount} onAssignGroup={onAssignGroup} />)}
      </motion.div>
    </motion.section>
  );
};
