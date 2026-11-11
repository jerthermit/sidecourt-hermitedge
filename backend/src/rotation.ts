import { maxCourtCount, type GameHistory, type Player, type RotationPlan, type SkillLevel } from './models.js';

type RotationAssignment = RotationPlan['assignments'][number];
type RotationResult = Pick<RotationPlan, 'assignments' | 'waiting' | 'canMix' | 'blockedReason'>;
type CourtIdentity = { id: number; name: string };

const MAX_SELECTED_PLAYERS = 24;
const MAX_COURTS_PER_COHORT = 6;
const MAX_OPTIONS_PER_STATE = 32;
const BEAM_WIDTH = 48;

interface Slot {
  court: CourtIdentity;
  anchorId: string;
  /** Null means the operator explicitly allowed this slot to cross skill bands. */
  band: SkillLevel | null;
}

interface RelationCounts {
  partners: Map<string, number>;
  opponents: Map<string, number>;
}

interface Score {
  maximumRepeatPartners: number;
  repeatPartners: number;
  maximumRepeatOpponents: number;
  repeatOpponents: number;
  ratedAssignments: number;
  ratingDifference: number;
  maximumRatingDifference: number;
  key: string;
}

interface SearchState {
  remaining: Player[];
  assignments: RotationAssignment[];
  score: Score;
}

interface Selection {
  selected: Player[];
  waiting: Player[];
  slots: Slot[];
  canMix: boolean;
  blockedReason: string | null;
}

function pairKey(left: string, right: string): string {
  return JSON.stringify(left < right ? [left, right] : [right, left]);
}

function increment(counts: Map<string, number>, left: string, right: string): void {
  const key = pairKey(left, right);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function relationCounts(history: GameHistory[]): RelationCounts {
  const partners = new Map<string, number>();
  const opponents = new Map<string, number>();

  for (const game of history) {
    if (game.status !== 'completed') continue;
    const ids = game.playerIds;
    if ((ids.length !== 2 && ids.length !== 4) || new Set(ids).size !== ids.length) continue;
    if (ids.length === 2) {
      increment(opponents, ids[0]!, ids[1]!);
      continue;
    }
    increment(partners, ids[0]!, ids[1]!);
    increment(partners, ids[2]!, ids[3]!);
    for (const left of ids.slice(0, 2)) {
      for (const right of ids.slice(2)) increment(opponents, left, right);
    }
  }

  return { partners, opponents };
}

function emptyScore(): Score {
  return {
    maximumRepeatPartners: 0,
    repeatPartners: 0,
    maximumRepeatOpponents: 0,
    repeatOpponents: 0,
    ratedAssignments: 0,
    ratingDifference: 0,
    maximumRatingDifference: 0,
    key: '',
  };
}

function addAssignment(score: Score, assignment: RotationAssignment, key: string): Score {
  const rating = assignment.metrics.ratingDifference;
  return {
    maximumRepeatPartners: Math.max(score.maximumRepeatPartners, assignment.metrics.repeatPartners),
    repeatPartners: score.repeatPartners + assignment.metrics.repeatPartners,
    maximumRepeatOpponents: Math.max(score.maximumRepeatOpponents, assignment.metrics.repeatOpponents),
    repeatOpponents: score.repeatOpponents + assignment.metrics.repeatOpponents,
    ratedAssignments: score.ratedAssignments + (rating === null ? 0 : 1),
    ratingDifference: score.ratingDifference + (rating ?? 0),
    maximumRatingDifference: Math.max(score.maximumRatingDifference, rating ?? 0),
    key: score.key ? `${score.key}|${key}` : key,
  };
}

function compareScore(left: Score, right: Score, avoidRepeatPartners: boolean): number {
  const comparisons: Array<[number, number]> = [];
  if (avoidRepeatPartners) {
    comparisons.push(
      [left.maximumRepeatPartners, right.maximumRepeatPartners],
      [left.repeatPartners, right.repeatPartners],
    );
  }
  comparisons.push(
    [left.maximumRepeatOpponents, right.maximumRepeatOpponents],
    [left.repeatOpponents, right.repeatOpponents],
    // More fully rated assignments makes the numeric comparison more truthful.
    [right.ratedAssignments, left.ratedAssignments],
    [left.ratingDifference, right.ratingDifference],
    [left.maximumRatingDifference, right.maximumRatingDifference],
  );
  for (const [leftValue, rightValue] of comparisons) {
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return left.key.localeCompare(right.key);
}

function missingPlayersMessage(missing: number): string {
  return `Waiting for ${missing} more player${missing === 1 ? '' : 's'}.`;
}

function missingBandMessage(band: SkillLevel, missing: number): string {
  return `Waiting for ${missing} more ${band} player${missing === 1 ? '' : 's'}.`;
}

function uniqueSortedCourts(courts: CourtIdentity[]): CourtIdentity[] {
  const seen = new Set<number>();
  return [...courts]
    .sort((left, right) => left.id - right.id || left.name.localeCompare(right.name))
    .filter((court) => !seen.has(court.id) && seen.add(court.id))
    .slice(0, maxCourtCount);
}

function selectOpen(players: Player[], courts: CourtIdentity[], groupSize: 2 | 4): Selection {
  const groupCount = Math.min(courts.length, Math.floor(players.length / groupSize));
  const selected = players.slice(0, groupCount * groupSize);
  const waiting = players.slice(selected.length);
  const slots = courts.slice(0, groupCount).map((court, index) => ({
    court,
    // The oldest simultaneous arrivals are spread across the available courts.
    anchorId: selected[index]!.id,
    band: null,
  }));
  return {
    selected,
    waiting,
    slots,
    canMix: false,
    blockedReason: groupCount < courts.length
      ? missingPlayersMessage(groupSize - waiting.length)
      : null,
  };
}

function selectSkillBanded(players: Player[], courts: CourtIdentity[], groupSize: 2 | 4,
  allowMixed: boolean): Selection {
  let remaining = [...players];
  const selectedIds = new Set<string>();
  const slots: Slot[] = [];
  let canMix = false;
  let blockedReason: string | null = null;

  for (const court of courts) {
    const anchor = remaining[0];
    if (!anchor) {
      blockedReason = missingPlayersMessage(groupSize);
      break;
    }

    const sameBand = remaining.filter((player) => player.skillLevel === anchor.skillLevel);
    let chosen: Player[];
    let band: SkillLevel | null;
    if (sameBand.length >= groupSize) {
      chosen = sameBand.slice(0, groupSize);
      band = anchor.skillLevel;
    } else if (remaining.length >= groupSize) {
      canMix = true;
      if (!allowMixed) {
        blockedReason = missingBandMessage(anchor.skillLevel, groupSize - sameBand.length);
        break;
      }
      chosen = remaining.slice(0, groupSize);
      band = null;
    } else {
      blockedReason = allowMixed
        ? missingPlayersMessage(groupSize - remaining.length)
        : missingBandMessage(anchor.skillLevel, groupSize - sameBand.length);
      break;
    }

    for (const player of chosen) selectedIds.add(player.id);
    const chosenIds = new Set(chosen.map((player) => player.id));
    remaining = remaining.filter((player) => !chosenIds.has(player.id));
    slots.push({ court, anchorId: anchor.id, band });
  }

  const selected = players.filter((player) => selectedIds.has(player.id));
  return {
    selected,
    waiting: players.filter((player) => !selectedIds.has(player.id)),
    slots,
    canMix,
    blockedReason: slots.length === courts.length ? null : blockedReason,
  };
}

function choose<T>(items: T[], count: number): T[][] {
  if (count === 0) return [[]];
  if (items.length < count) return [];
  const combinations: T[][] = [];
  const current: T[] = [];
  const visit = (start: number): void => {
    if (current.length === count) {
      combinations.push([...current]);
      return;
    }
    const needed = count - current.length;
    for (let index = start; index <= items.length - needed; index += 1) {
      current.push(items[index]!);
      visit(index + 1);
      current.pop();
    }
  };
  visit(0);
  return combinations;
}

function teamArrangements(group: Player[], groupSize: 2 | 4): Player[][] {
  if (groupSize === 2) return [[group[0]!, group[1]!]];
  const [anchor, second, third, fourth] = group as [Player, Player, Player, Player];
  return [
    [anchor, second, third, fourth],
    [anchor, third, second, fourth],
    [anchor, fourth, second, third],
  ];
}

function metrics(players: Player[], counts: RelationCounts): RotationAssignment['metrics'] {
  const half = players.length / 2;
  const first = players.slice(0, half);
  const second = players.slice(half);
  let repeatPartners = 0;
  if (players.length === 4) {
    repeatPartners += counts.partners.get(pairKey(first[0]!.id, first[1]!.id)) ?? 0;
    repeatPartners += counts.partners.get(pairKey(second[0]!.id, second[1]!.id)) ?? 0;
  }
  let repeatOpponents = 0;
  for (const left of first) {
    for (const right of second) {
      repeatOpponents += counts.opponents.get(pairKey(left.id, right.id)) ?? 0;
    }
  }
  const ratingDifference = players.every((player) => player.skillRating !== null)
    ? Math.abs(
      first.reduce((sum, player) => sum + player.skillRating!, 0)
      - second.reduce((sum, player) => sum + player.skillRating!, 0),
    )
    : null;
  return { ratingDifference, repeatPartners, repeatOpponents };
}

function stableAssignmentKey(players: Player[], queueIndex: Map<string, number>): string {
  return players.map((player) => String(queueIndex.get(player.id) ?? Number.MAX_SAFE_INTEGER)
    .padStart(3, '0')).join('.');
}

function bestTeamArrangement(group: Player[], court: CourtIdentity, groupSize: 2 | 4,
  counts: RelationCounts, queueIndex: Map<string, number>, avoidRepeatPartners: boolean,
  mixedRequiresApproval: boolean): {
    assignment: RotationAssignment;
    key: string;
  } {
  const options = teamArrangements(group, groupSize).map((players) => {
    const assignment: RotationAssignment = {
      courtId: court.id,
      courtName: court.name,
      players,
      mixed: mixedRequiresApproval
        && new Set(players.map((player) => player.skillLevel)).size > 1,
      metrics: metrics(players, counts),
    };
    const key = stableAssignmentKey(players, queueIndex);
    return { assignment, key, score: addAssignment(emptyScore(), assignment, key) };
  });
  options.sort((left, right) => compareScore(left.score, right.score, avoidRepeatPartners));
  return options[0]!;
}

function canCompleteSlots(remaining: Player[], future: Slot[], groupSize: 2 | 4): boolean {
  const requiredByBand = new Map<SkillLevel, number>();
  let unrestricted = 0;
  for (const slot of future) {
    if (slot.band === null) unrestricted += groupSize - 1;
    else requiredByBand.set(slot.band, (requiredByBand.get(slot.band) ?? 0) + groupSize - 1);
  }
  const availableByBand = new Map<SkillLevel, number>();
  for (const player of remaining) {
    availableByBand.set(player.skillLevel, (availableByBand.get(player.skillLevel) ?? 0) + 1);
  }
  let reserved = 0;
  for (const [band, required] of requiredByBand) {
    if ((availableByBand.get(band) ?? 0) < required) return false;
    reserved += required;
  }
  return remaining.length - reserved >= unrestricted;
}

function optimize(selected: Player[], slots: Slot[], groupSize: 2 | 4,
  avoidRepeatPartners: boolean, counts: RelationCounts, mixedRequiresApproval: boolean): RotationAssignment[] {
  if (slots.length === 0) return [];
  const byId = new Map(selected.map((player) => [player.id, player]));
  const anchorIds = new Set(slots.map((slot) => slot.anchorId));
  const queueIndex = new Map(selected.map((player, index) => [player.id, index]));
  let states: SearchState[] = [{
    remaining: selected.filter((player) => !anchorIds.has(player.id)),
    assignments: [],
    score: emptyScore(),
  }];

  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    const slot = slots[slotIndex]!;
    const anchor = byId.get(slot.anchorId);
    if (!anchor) throw new Error('Rotation slot anchor is missing from the selected queue.');
    const nextStates: SearchState[] = [];

    for (const state of states) {
      const eligible = slot.band === null
        ? state.remaining
        : state.remaining.filter((player) => player.skillLevel === slot.band);
      const options = choose(eligible, groupSize - 1).map((mates) => {
        const arranged = bestTeamArrangement(
          [anchor, ...mates], slot.court, groupSize, counts, queueIndex, avoidRepeatPartners,
          mixedRequiresApproval,
        );
        const selectedMateIds = new Set(mates.map((player) => player.id));
        const remaining = state.remaining.filter((player) => !selectedMateIds.has(player.id));
        return {
          remaining,
          assignment: arranged.assignment,
          score: addAssignment(state.score, arranged.assignment, arranged.key),
        };
      }).filter((option) => canCompleteSlots(option.remaining, slots.slice(slotIndex + 1), groupSize));

      options.sort((left, right) => compareScore(left.score, right.score, avoidRepeatPartners));
      for (const option of options.slice(0, MAX_OPTIONS_PER_STATE)) {
        nextStates.push({
          remaining: option.remaining,
          assignments: [...state.assignments, option.assignment],
          score: option.score,
        });
      }
    }

    nextStates.sort((left, right) => compareScore(left.score, right.score, avoidRepeatPartners));
    states = nextStates.slice(0, BEAM_WIDTH);
    if (states.length === 0) throw new Error('Rotation planner could not satisfy the selected queue.');
  }

  states.sort((left, right) => compareScore(left.score, right.score, avoidRepeatPartners));
  return states[0]!.assignments;
}

/**
 * Builds a bounded, deterministic review plan. `players` must already be the
 * authoritative holding-pool FIFO; `courts` must already be empty and available.
 * Each search covers at most six courts and 24 selected players. Later courts
 * use the remaining FIFO; pairing optimization does not cross cohort boundaries.
 */
export function buildRotationAssignments(
  players: Player[],
  courts: CourtIdentity[],
  gameMode: 'singles' | 'doubles',
  rotationMode: 'open' | 'skill-banded',
  allowMixed: boolean,
  avoidRepeatPartners: boolean,
  history: GameHistory[],
): RotationResult {
  const groupSize = gameMode === 'singles' ? 2 : 4;
  const availableCourts = uniqueSortedCourts(courts);
  if (availableCourts.length === 0) {
    return {
      assignments: [],
      waiting: [...players],
      canMix: false,
      blockedReason: 'No empty available courts.',
    };
  }

  const cohortSize = Math.min(MAX_COURTS_PER_COHORT, Math.floor(MAX_SELECTED_PLAYERS / groupSize));
  const counts = relationCounts(history);
  const assignments: RotationAssignment[] = [];
  let waiting = [...players];
  let canMix = false;
  let blockedReason: string | null = null;

  for (let offset = 0; offset < availableCourts.length; offset += cohortSize) {
    const cohort = availableCourts.slice(offset, offset + cohortSize);
    const selection = rotationMode === 'skill-banded'
      ? selectSkillBanded(waiting, cohort, groupSize, allowMixed)
      : selectOpen(waiting, cohort, groupSize);
    assignments.push(...optimize(
      selection.selected,
      selection.slots,
      groupSize,
      avoidRepeatPartners,
      counts,
      rotationMode === 'skill-banded',
    ));
    waiting = selection.waiting;
    canMix ||= selection.canMix;
    blockedReason = selection.blockedReason;
    // A later cohort must not skip a blocked oldest band or an incomplete group.
    if (selection.slots.length < cohort.length) break;
  }

  return { assignments, waiting, canMix, blockedReason };
}
