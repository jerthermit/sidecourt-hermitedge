import React from 'react';
import type { Player, SkillLevel } from '../types/models';

interface PlayerCardProps {
  player: Player;
  isDragging?: boolean;
  showLevel?: boolean;
}

const levelLabels: Record<SkillLevel, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  unrated: 'Unrated',
};

export const PlayerCard: React.FC<PlayerCardProps> = ({
  player,
  isDragging = false,
  showLevel = true,
}) => {
  return (
    <div className={`player-card player-card--${player.skillLevel} ${isDragging ? 'player-card--dragging' : ''}`}>
      <span className="player-card__name" title={player.name}>
        {player.name}
      </span>
      <span className="player-card__details">
        {showLevel ? <span>{levelLabels[player.skillLevel]}</span> : null}
        <span className="player-card__rating" aria-label={player.skillRating === null ? 'Local rating not recorded' : `Local rating ${player.skillRating.toFixed(1)}`}>{player.skillRating?.toFixed(1) ?? '—'}</span>
      </span>
    </div>
  );
};
