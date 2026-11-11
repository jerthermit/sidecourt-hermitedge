import { describe, expect, it } from 'vitest';
import type { GameHistory, Player, SkillLevel } from '../src/models.js';
import { buildRotationAssignments } from '../src/rotation.js';

const courts = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `Venue ${index + 1}` }));
function players(count: number, skillLevel: SkillLevel = 'intermediate', offset = 0): Player[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${offset + index}`, name: `Player ${offset + index}`, skillLevel, skillRating: 3.5,
    playStyle: 'Balanced', attendance: 'ready', source: null, externalId: null,
    location: { type: 'holding-pool', index: offset + index }, createdAt: offset + index,
    gamesPlayed: 0, playedSeconds: 0, waitingSince: offset + index,
  }));
}
const ids = (queue: Player[]) => queue.map((player) => player.id);

describe('bounded rotation cohorts', () => {
  it.each(['singles', 'doubles'] as const)('fills sixteen %s courts from the FIFO without reusing players', (mode) => {
    const groupSize = mode === 'singles' ? 2 : 4;
    const queue = players(16 * groupSize + 5);
    const available = courts(16).reverse();
    const result = buildRotationAssignments(queue, available, mode, 'open', false, true, []);
    expect(result.assignments.map((assignment) => assignment.courtId)).toEqual(courts(16).map((court) => court.id));
    expect(result.assignments.map((assignment) => assignment.courtName)).toEqual(courts(16).map((court) => court.name));
    const assigned = result.assignments.flatMap((assignment) => ids(assignment.players));
    expect(assigned).toHaveLength(16 * groupSize);
    expect(new Set(assigned)).toEqual(new Set(ids(queue.slice(0, 16 * groupSize))));
    for (const offset of [0, 6, 12]) {
      const count = Math.min(6, 16 - offset);
      expect(new Set(result.assignments.slice(offset, offset + count).flatMap((assignment) => ids(assignment.players))))
        .toEqual(new Set(ids(queue.slice(offset * groupSize, (offset + count) * groupSize))));
    }
    expect(ids(result.waiting)).toEqual(ids(queue.slice(16 * groupSize)));
    expect(result).toMatchObject({ canMix: false, blockedReason: null });
    expect(buildRotationAssignments(queue, available, mode, 'open', false, true, [])).toEqual(result);
  });

  it('retains the exact incomplete open remainder beyond the first cohort', () => {
    const queue = players(29);
    const result = buildRotationAssignments(queue, courts(16), 'doubles', 'open', false, true, []);
    expect(result.assignments).toHaveLength(7);
    expect(new Set(result.assignments.flatMap((assignment) => ids(assignment.players))))
      .toEqual(new Set(ids(queue.slice(0, 28))));
    expect(ids(result.waiting)).toEqual(ids(queue.slice(28)));
    expect(result).toMatchObject({ canMix: false, blockedReason: 'Waiting for 3 more players.' });
  });

  it('stops at a blocked oldest skill band inside a later cohort', () => {
    const queue = [...players(24, 'beginner'), ...players(4, 'intermediate', 24),
      ...players(1, 'unrated', 28), ...players(16, 'advanced', 29)];
    const result = buildRotationAssignments(queue, courts(16), 'doubles', 'skill-banded', false, true, []);
    expect(result.assignments).toHaveLength(7);
    expect(result.assignments.every((assignment) => !assignment.mixed)).toBe(true);
    expect(new Set(result.assignments.flatMap((assignment) => ids(assignment.players))))
      .toEqual(new Set(ids(queue.slice(0, 28))));
    expect(ids(result.waiting)).toEqual(ids(queue.slice(28)));
    expect(result).toMatchObject({ canMix: true, blockedReason: 'Waiting for 3 more unrated players.' });
  });

  it('finds oldest-band members beyond the first 24 queue positions before advancing cohorts', () => {
    const queue = [...players(1, 'beginner'), ...players(23, 'intermediate', 1),
      ...players(3, 'beginner', 24), ...players(41, 'intermediate', 27)];
    const result = buildRotationAssignments(queue, courts(16), 'doubles', 'skill-banded', false, true, []);
    expect(result.assignments).toHaveLength(16);
    expect(new Set(ids(result.assignments[0]!.players))).toEqual(new Set(['player-0', 'player-24', 'player-25', 'player-26']));
    expect(result.assignments.every((assignment) => !assignment.mixed
      && new Set(assignment.players.map((player) => player.skillLevel)).size === 1)).toBe(true);
    expect(ids(result.waiting)).toEqual(ids(queue.slice(64)));
    expect(result).toMatchObject({ canMix: false, blockedReason: null });
  });

  it('retains earlier mixed approval when later cohorts are entirely one band', () => {
    const queue = [...players(1, 'beginner'), ...players(23, 'intermediate', 1), ...players(40, 'advanced', 24)];
    const result = buildRotationAssignments(queue, courts(16), 'doubles', 'skill-banded', true, true, []);
    expect(result.assignments).toHaveLength(16);
    expect(result.assignments[0]!.mixed).toBe(true);
    expect(result.assignments.slice(1).every((assignment) => !assignment.mixed)).toBe(true);
    expect(result.waiting).toEqual([]);
    expect(result).toMatchObject({ canMix: true, blockedReason: null });
  });

  it('uses completed history for the team metrics of a later cohort', () => {
    const queue = players(28);
    const game: GameHistory = { id: 'previous', sessionId: 's', courtId: 7, courtName: 'Venue 7',
      players: queue.slice(24).map((player) => player.name), playerIds: ids(queue.slice(24)),
      startedAt: 1, endedAt: 101, duration: 100, status: 'completed', reason: null, correctedAt: null };
    const result = buildRotationAssignments(queue, courts(7), 'doubles', 'open', false, true, [game]);
    expect(result.assignments[6]!.metrics).toEqual({ ratingDifference: 0, repeatPartners: 0, repeatOpponents: 2 });
    expect(buildRotationAssignments(queue, courts(7), 'doubles', 'open', false, true,
      [game, { ...game, id: 'voided', status: 'voided' }])).toEqual(result);
  });
});
