import type { Court, Destination, Player, QueueLane } from '../types/models';

export interface PlayerMoveOption {
  value: string;
  label: string;
  destination: Destination;
}

export function playerIsLocked(player: Player, courts: Court[]): boolean {
  const location = player.location;
  return player.attendance !== 'ready'
    || (location.type === 'court' && courts.some((court) => court.id === location.courtId && court.status === 'in-play'));
}

export function playerMoveOptions(player: Player, courts: Court[], groupSize: number): PlayerMoveOption[] {
  if (playerIsLocked(player, courts)) return [];
  const options: PlayerMoveOption[] = [];
  const location = player.location;
  if (location.type !== 'holding-pool') {
    options.push({ value: 'waiting', label: 'Waiting queue', destination: { type: 'holding-pool' } });
  }
  const lane: QueueLane = player.skillLevel === 'unrated' ? 'mixed' : player.skillLevel;
  if (location.type !== 'next-game-pool' || location.lane !== lane) {
    options.push({ value: `next-${lane}`, label: 'Next game', destination: { type: 'next-game-pool', lane } });
  }
  if (lane !== 'mixed' && (location.type !== 'next-game-pool' || location.lane !== 'mixed')) {
    options.push({ value: 'next-mixed', label: 'Open group', destination: { type: 'next-game-pool', lane: 'mixed' } });
  }
  for (const court of courts) {
    if (court.status === 'available' && court.players.length < groupSize
      && (location.type !== 'court' || location.courtId !== court.id)) {
      options.push({ value: `court-${court.id}`, label: court.name ?? `Court ${court.id}`, destination: { type: 'court', courtId: court.id } });
    }
  }
  return options;
}
