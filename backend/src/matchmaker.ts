import { badRequest } from './errors.js';
import type { HoldingCandidate, ProposalDraft } from './models.js';

function imbalance(players: HoldingCandidate[]): number {
  const ratings = players.map((player) => {
    if (player.skillRating === null) throw new Error('Numeric balance requires every rating to be known.');
    return player.skillRating;
  });
  const half = players.length / 2;
  return Math.abs(ratings.slice(0, half).reduce((sum, rating) => sum + rating, 0)
    - ratings.slice(half).reduce((sum, rating) => sum + rating, 0));
}

function preferredPairings(selected: HoldingCandidate[], previousTeams: string[][],
  avoidRepeats: boolean): HoldingCandidate[][] {
  if (selected.length === 2) return [selected];
  const [a, b, c, d] = selected as [HoldingCandidate, HoldingCandidate, HoldingCandidate, HoldingCandidate];
  const pairings = [[a, b, c, d], [a, c, b, d], [a, d, b, c]];
  const known = selected.every((player) => player.skillRating !== null);
  const repeatCounts = new Map<string, number>();
  for (const team of previousTeams) {
    if (team.length !== 2 || new Set(team).size !== 2) continue;
    const key = [...team].sort().join(',');
    repeatCounts.set(key, (repeatCounts.get(key) ?? 0) + 1);
  }
  const repeats = (players: HoldingCandidate[]) => [players.slice(0, 2), players.slice(2)]
    .reduce((sum, team) => sum + (repeatCounts.get(team.map((player) => player.id).sort().join(',')) ?? 0), 0);
  const minimumImbalance = known ? Math.min(...pairings.map(imbalance)) : 0;
  let eligible = known ? pairings.filter((pairing) => imbalance(pairing)
    <= minimumImbalance + (avoidRepeats ? 1 : 0) + 1e-9) : pairings;
  if (avoidRepeats) {
    const minimumRepeats = Math.min(...eligible.map(repeats));
    eligible = eligible.filter((pairing) => repeats(pairing) === minimumRepeats);
  }
  if (known) {
    const bestImbalance = Math.min(...eligible.map(imbalance));
    eligible = eligible.filter((pairing) => Math.abs(imbalance(pairing) - bestImbalance) < 1e-9);
  }
  return eligible;
}

/** Legacy single-court review; session-wide planning lives in rotation.ts. */
export class Matchmaker {
  async propose(candidates: HoldingCandidate[], groupSize: 2 | 4 = 4,
    previousTeams: string[][] = [], avoidRepeatPartners = true): Promise<ProposalDraft> {
    if (candidates.length < groupSize) {
      throw badRequest(`At least ${groupSize} players must be waiting before a match can be proposed.`);
    }
    const selected = preferredPairings(candidates.slice(0, groupSize), previousTeams, avoidRepeatPartners)[0]!;
    return { source: 'rules-fallback', playerIds: selected.map(player => player.id),
      notice: 'Rules determined this pairing.' + (selected.some(player => player.skillRating === null)
        ? ' Unknown ratings. Teams arranged without numeric balance.' : '') };
  }
}
