import type { Active, Announcements, Over } from '@dnd-kit/core';
import type { Court } from '../types/models';

export function dragAnnouncements(courts: Pick<Court, 'id' | 'name'>[]): Announcements {
  const name = (active: Active) => typeof active.data.current?.player?.name === 'string'
    ? active.data.current.player.name : 'Player';
  const destination = (over: Over) => {
    const data = over.data.current;
    if (data?.type === 'holding-pool') return 'Waiting';
    if (data?.type === 'court') return courts.find(court => court.id === data.courtId)?.name?.trim() || 'the court';
    if (data?.type === 'next-game-pool') {
      if (data.lane === 'mixed') return 'Open group staging';
      return ['beginner', 'intermediate', 'advanced'].includes(data.lane) ? `${data.lane} staging` : 'Next game staging';
    }
    if (data?.type === 'player' && typeof data.player?.name === 'string') return `${data.player.name}'s position`;
    return 'the drop area';
  };
  return {
    onDragStart: ({ active }) => `${name(active)} picked up.`,
    onDragOver: ({ active, over }) => over?.id === active.id ? undefined
      : over ? `${name(active)} over ${destination(over)}.` : `${name(active)} outside a drop area.`,
    onDragEnd: ({ active, over }) => over?.id === active.id ? `${name(active)} released in place.`
      : over ? `${name(active)} dropped over ${destination(over)}.` : `${name(active)} released outside a drop area.`,
    onDragCancel: ({ active }) => `${name(active)} move cancelled.`,
  };
}
