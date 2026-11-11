import { useState, type ReactNode } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { interactionEase, useMotionPolicy } from '../lib/interactionMotion';
import type { Attendance, Court, Player } from '../types/models';

interface RosterRowsProps {
  players: Player[];
  courts: Court[];
  playingCourts: Map<string, number>;
  disabled: boolean;
  onAttendance: (id: string, attendance: Attendance) => Promise<boolean>;
  onRequestRemove?: (player: Player, trigger: HTMLButtonElement) => void;
}

const statusLabels = { expected: 'Expected', ready: 'Ready', playing: 'Playing', resting: 'Resting', departed: 'Left' };

function RosterMore({ name, disabled, children }: { name: string; disabled: boolean; children: ReactNode }) {
  const { reduced, dragging } = useMotionPolicy();
  const instant = reduced || dragging;
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const guard = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    if (expanded && !disabled) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return <details className="roster-more" open={expanded || closing}>
    <summary className="button button--ghost" aria-label={`More actions for ${name}`} aria-disabled={disabled}
      aria-expanded={expanded} onClick={(event) => {
        event.preventDefault();
        if (disabled) return;
        setClosing(expanded && !instant);
        setExpanded(!expanded);
      }}>More</summary>
    <motion.div className="roster-more__menu" role="group" aria-label={`More actions for ${name}`}
      inert={!expanded || disabled} initial={false}
      animate={{ height: expanded ? 'auto' : 0, opacity: expanded ? 1 : 0 }}
      transition={{ type: 'tween', duration: instant ? 0 : 0.18, ease: interactionEase }}
      style={{ overflow: 'hidden' }} onAnimationComplete={() => { if (!expanded) setClosing(false); }}
      onClickCapture={guard} onKeyDownCapture={guard}>
      {children}
    </motion.div>
  </details>;
}

export function RosterRows({ players, courts, playingCourts, disabled, onAttendance, onRequestRemove }: RosterRowsProps) {
  const { reduced, dragging, layout } = useMotionPolicy();
  const instant = reduced || dragging;
  const isPresent = useIsPresent();
  const locked = disabled || !isPresent;
  const rowLayout = players.map(player => `${player.id}:${player.attendance}:${player.location.type}`).join(',');
  const guard = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    if (isPresent) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return <motion.tbody inert={!isPresent} data-presence={isPresent ? 'present' : 'exiting'}
    initial={instant ? false : { opacity: 0 }} animate={{ opacity: 1 }}
    exit={{ opacity: 0, transition: { duration: instant ? 0 : 0.12 } }}
    transition={{ type: 'tween', duration: instant ? 0 : 0.18, ease: interactionEase }}
    onClickCapture={guard} onKeyDownCapture={guard}>
    {players.map((player) => {
      const activeCourt = playingCourts.get(player.id);
      const activeMatch = activeCourt !== undefined;
      const status = activeMatch ? 'playing' : player.attendance;
      const locatedCourtId = player.location.type === 'court' ? player.location.courtId : undefined;
      const location = player.location.type === 'court'
        ? courts.find((court) => court.id === locatedCourtId)?.name ?? `Court ${String(locatedCourtId).padStart(2, '0')}`
        : player.location.type === 'next-game-pool' ? 'Next game' : null;
      return <motion.tr key={player.id} layout={layout ? 'position' : false}
        layoutDependency={rowLayout}
        transition={{ type: 'tween', duration: instant ? 0 : 0.2, ease: interactionEase }}>
        <td className="roster-player"><strong>{player.name}</strong>
          {player.externalId ? <small>{player.externalId} / {player.source}</small> : null}
          <small className="roster-mobile-games">{player.gamesPlayed ?? '—'} {player.gamesPlayed === 1 ? 'game' : 'games'}</small>
        </td>
        <td className="roster-level">{player.skillLevel}</td>
        <td className="roster-rating">{player.skillRating?.toFixed(1) ?? '—'}</td>
        <td className="roster-games">{player.gamesPlayed ?? '—'}</td>
        <td><span className={`attendance-state attendance-state--${status}`}>{statusLabels[status]}</span>{location ? <small className="roster-location">{location}</small> : null}</td>
        <td className="roster-actions">
          {player.attendance === 'expected' || player.attendance === 'departed' ? (
            <button type="button" className="button button--secondary" aria-label={`Check in ${player.name}`} disabled={locked} onClick={() => void onAttendance(player.id, 'ready')}>Check in</button>
          ) : player.attendance === 'resting' ? (
            <button type="button" className="button button--secondary" aria-label={`Resume ${player.name}`} disabled={locked} onClick={() => void onAttendance(player.id, 'ready')}>Resume</button>
          ) : (
            <button type="button" className="button button--secondary" aria-label={`Rest ${player.name}`} title={activeMatch ? 'End the match first' : undefined} disabled={locked || activeMatch} onClick={() => void onAttendance(player.id, 'resting')}>Rest</button>
          )}
          {player.attendance !== 'departed' || onRequestRemove ? <RosterMore name={player.name} disabled={locked}>
            {player.attendance !== 'departed' ? <button type="button" className="button button--ghost"
              aria-label={`Mark ${player.name} as left`} title={activeMatch ? 'End the match first' : undefined}
              disabled={locked || activeMatch} onClick={() => void onAttendance(player.id, 'departed')}>Leave</button> : null}
            {onRequestRemove ? <button type="button" className="button button--danger"
              aria-label={`Remove ${player.name} from roster`} title={activeMatch ? 'End the match first' : undefined}
              disabled={locked || activeMatch} onClick={(event) => onRequestRemove(player, event.currentTarget)}>Remove</button> : null}
          </RosterMore> : null}
        </td>
      </motion.tr>;
    })}
  </motion.tbody>;
}
