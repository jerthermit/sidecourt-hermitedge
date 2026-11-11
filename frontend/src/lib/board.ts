import type { GameHistory, Player } from '../types/models';

export const formatWait = (waitingSince: number | null | undefined, now: number): string => {
  if (waitingSince == null) return '—';
  const minutes = Math.max(0, Math.floor((now - waitingSince) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export function historyIdentities(roster: Player[], history: GameHistory[]): Array<{ id: string; name: string }> {
  const identities = new Map<string, string>();
  for (const game of history) game.playerIds?.forEach((id, index) => {
    if (id && game.players[index]) identities.set(id, game.players[index]);
  });
  for (const player of roster) identities.set(player.id, player.name);
  return Array.from(identities, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
