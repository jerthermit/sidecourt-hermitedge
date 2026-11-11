import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../src/db.js';
import type { AppSnapshot, SessionReport } from '../src/models.js';

const epoch = 1_800_000_000_000;
const repositories: Repository[] = [];
const repository = () => {
  const value = new Repository(':memory:');
  repositories.push(value);
  return value;
};
const seeded = () => {
  const value = repository();
  value.seedPublicFixture();
  return value;
};
const reports = (value: Repository) => value.getSnapshot().sessions.map((session) => value.getSessionReport(session.id));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(epoch);
});

afterEach(() => {
  repositories.splice(0).forEach((value) => value.close());
  vi.restoreAllMocks();
});

function expectLedgerMatchesHistory(report: SessionReport) {
  const completed = report.matches.filter((match) => match.status === 'completed');
  expect(report.totals).toEqual({
    registeredPlayers: report.participants.length,
    checkedInPlayers: report.participants.filter((player) => player.checkedInAt !== null).length,
    completedMatches: completed.length,
    voidedMatches: report.matches.length - completed.length,
    correctedMatches: completed.filter((match) => match.correctedAt !== null).length,
    completedCourtSeconds: completed.reduce((total, match) => total + match.duration, 0),
    unattributedCompletedMatches: 0,
  });
  const participants = new Map(report.participants.map((player) => [player.id, player]));
  expect(participants.size).toBe(report.participants.length);
  for (const match of report.matches) {
    expect(match.sessionId).toBe(report.session.id);
    expect(match.courtId).toBeGreaterThanOrEqual(1);
    expect(match.courtId).toBeLessThanOrEqual(12);
    expect(match.courtName).toBe(`Court ${match.courtId}`);
    expect(match.playerIds).toHaveLength(4);
    expect(new Set(match.playerIds).size).toBe(4);
    expect(match.players).toEqual(match.playerIds.map((id) => participants.get(id)?.name));
    expect(match.startedAt).toBeGreaterThanOrEqual(report.session.startedAt);
    expect(match.endedAt).toBeGreaterThanOrEqual(match.startedAt);
    expect(match.endedAt).toBeLessThanOrEqual(report.session.endedAt ?? epoch);
    expect(match.duration).toBe(Math.floor((match.endedAt - match.startedAt) / 1000));
    if (match.status === 'completed') expect(match.duration).toBeGreaterThan(0);
    if (match.correctedAt !== null) {
      expect(match.reason?.length).toBeGreaterThanOrEqual(3);
      expect(match.correctedAt).toBeGreaterThanOrEqual(match.endedAt);
      expect(match.correctedAt).toBeLessThanOrEqual(epoch);
    }
    for (const id of match.playerIds) {
      expect(participants.get(id)?.checkedInAt).not.toBeNull();
      expect(participants.get(id)!.checkedInAt!).toBeLessThanOrEqual(match.startedAt);
    }
  }
  for (const player of report.participants) {
    const games = completed.filter((match) => match.playerIds.includes(player.id));
    expect(player.gamesPlayed).toBe(games.length);
    expect(player.playedSeconds).toBe(games.reduce((total, match) => total + match.duration, 0));
    if (player.attendance === 'expected') {
      expect(player.checkedInAt).toBeNull();
      expect(report.matches.some((match) => match.playerIds.includes(player.id))).toBe(false);
    }
  }
  expect(report.participants.reduce((total, player) => total + player.gamesPlayed, 0)).toBe(completed.length * 4);
  expect(report.participants.reduce((total, player) => total + player.playedSeconds, 0))
    .toBe(report.totals.completedCourtSeconds * 4);
}

function expectNoOverlaps(report: SessionReport, snapshot?: AppSnapshot) {
  const intervals = new Map<string, Array<{ start: number; end: number }>>();
  const add = (key: string, start: number, end: number) => {
    const values = intervals.get(key) ?? [];
    values.push({ start, end });
    intervals.set(key, values);
  };
  for (const match of report.matches) {
    add(`court:${match.courtId}`, match.startedAt, match.endedAt);
    for (const id of match.playerIds) add(`player:${id}`, match.startedAt, match.endedAt);
  }
  if (snapshot) {
    for (const court of snapshot.courts.filter((item) => item.status === 'in-play')) {
      expect(court.players).toHaveLength(4);
      expect(court.gameStartedAt).not.toBeNull();
      expect(court.gameStartedAt!).toBeGreaterThanOrEqual(report.session.startedAt);
      expect(court.gameStartedAt!).toBeLessThan(epoch);
      add(`court:${court.id}`, court.gameStartedAt!, epoch);
      for (const player of court.players) add(`player:${player.id}`, court.gameStartedAt!, epoch);
    }
  }
  for (const values of intervals.values()) {
    values.sort((left, right) => left.start - right.start);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]!.start).toBeGreaterThanOrEqual(values[index - 1]!.end);
    }
  }
}

describe('fictional public club fixture', () => {
  it('populates twelve courts, full names, varied attendance and a usable waiting group', () => {
    const value = seeded();
    const snapshot = value.getSnapshot();
    expect(snapshot.settings).toMatchObject({ venueName: 'Sidecourt', courtCount: 12,
      courtNames: Array.from({ length: 12 }, (_, index) => `Court ${index + 1}`) });
    expect(snapshot.roster).toHaveLength(96);
    expect(new Set(snapshot.roster.map((player) => player.name)).size).toBe(96);
    expect(snapshot.roster.every((player) => player.name.trim().split(/\s+/).length >= 2
      && !/demo player|club player|test player/i.test(player.name))).toBe(true);
    expect(snapshot.roster.filter((player) => player.attendance === 'ready')).toHaveLength(76);
    expect(snapshot.roster.filter((player) => player.attendance === 'resting')).toHaveLength(8);
    expect(snapshot.roster.filter((player) => player.attendance === 'expected')).toHaveLength(8);
    expect(snapshot.roster.filter((player) => player.attendance === 'departed')).toHaveLength(4);
    expect(snapshot.courts.filter((court) => court.status === 'in-play')).toHaveLength(8);
    expect(snapshot.courts.slice(8, 10).every((court) => court.status === 'available'
      && court.players.length === 4 && court.gameStartedAt === null)).toBe(true);
    expect(snapshot.courts.slice(10).every((court) => court.status === 'available'
      && court.players.length === 0 && court.gameStartedAt === null)).toBe(true);
    expect(snapshot.holdingPool).toHaveLength(32);
    expect(snapshot.nextGamePool.intermediate).toHaveLength(4);
    expect(Object.values(snapshot.nextGamePool).flat()).toHaveLength(4);
    const visible = [...snapshot.courts.flatMap((court) => court.players),
      ...Object.values(snapshot.nextGamePool).flat(), ...snapshot.holdingPool];
    expect(visible).toHaveLength(76);
    expect(new Set(visible.map((player) => player.id)).size).toBe(76);
    for (const player of snapshot.roster) {
      if (player.attendance === 'ready' && player.location.type !== 'court') {
        expect(player.waitingSince).not.toBeNull();
        expect(player.waitingSince!).toBeLessThanOrEqual(epoch);
      } else expect(player.waitingSince).toBeNull();
      if (player.attendance !== 'ready') expect(player.location.type).toBe('holding-pool');
    }
    const holdingPositions = snapshot.roster.filter((player) => player.location.type === 'holding-pool')
      .map((player) => player.location.type === 'holding-pool' ? player.location.index : -1).sort((a, b) => a - b);
    expect(holdingPositions).toEqual(Array.from({ length: holdingPositions.length }, (_, index) => index));
    expect(snapshot.nextGamePool.intermediate.map((player) => player.location.type === 'next-game-pool'
      ? player.location.index : -1)).toEqual([0, 1, 2, 3]);
  });

  it('keeps current and archived totals, player ledgers, identities and timelines consistent', () => {
    const value = seeded();
    const snapshot = value.getSnapshot();
    const current = value.getSessionReport();
    expect(snapshot.sessions).toHaveLength(3);
    expect(snapshot.sessions.filter((session) => session.endedAt === null)).toEqual([snapshot.session]);
    expect(current.totals).toMatchObject({ registeredPlayers: 96, checkedInPlayers: 88,
      completedMatches: 36, voidedMatches: 1, correctedMatches: 1 });
    expect(current.activeMatches).toBe(8);
    expect(current.matches).toHaveLength(37);
    for (const report of reports(value)) {
      expect(report.matches.length).toBeGreaterThan(0);
      expectLedgerMatchesHistory(report);
      expectNoOverlaps(report, report.session.id === snapshot.session.id ? snapshot : undefined);
      if (report.session.id !== snapshot.session.id) {
        expect(report.session.endedAt).not.toBeNull();
        expect(report.session.endedAt!).toBeLessThan(snapshot.session.startedAt);
        expect(report.activeMatches).toBe(0);
      }
    }
    for (const player of snapshot.roster) {
      expect(player.gamesPlayed).toBe(current.participants.find((participant) => participant.id === player.id)!.gamesPlayed);
      expect(player.playedSeconds).toBe(current.participants.find((participant) => participant.id === player.id)!.playedSeconds);
    }
  });

  it('keeps both archives immutable while the current session changes', () => {
    const value = seeded();
    const before = reports(value).filter((report) => report.session.endedAt !== null);
    expect(before).toHaveLength(2);
    const exports = before.map((report) => ({ attendance: value.exportSession('attendance', report.session.id),
      matches: value.exportSession('matches', report.session.id) }));
    const auditBeforeRead = value.getAuditEntriesForTests();
    before.forEach((report) => value.getSessionReport(report.session.id));
    expect(value.getAuditEntriesForTests()).toEqual(auditBeforeRead);
    value.setAttendance(value.getSnapshot().holdingPool[0]!.id, 'resting');
    value.endGame(1);
    for (const [index, report] of before.entries()) {
      expect(() => value.voidRecordedGame(report.matches[0]!.id, 'Attempt to edit archive')).toThrow('read-only');
      expect(() => value.correctRecordedGame(report.matches[0]!.id, {
        playerIds: report.matches[0]!.playerIds, durationSeconds: 60, reason: 'Attempt to edit archive',
      })).toThrow('read-only');
      expect(value.getSessionReport(report.session.id)).toEqual(report);
      expect(value.exportSession('attendance', report.session.id)).toBe(exports[index]!.attendance);
      expect(value.exportSession('matches', report.session.id)).toBe(exports[index]!.matches);
    }
    expect(value.getSessionReport().totals.completedMatches).toBe(37);
    expect(value.getSessionReport().activeMatches).toBe(7);
  });

  it('uses fresh visitor identities and seeds each board only once', () => {
    const first = seeded();
    const second = seeded();
    const before = first.getSnapshot();
    const beforeReports = reports(first);
    const beforeAudit = first.getAuditEntriesForTests();
    first.seedPublicFixture();
    first.seedPublicFixture();
    expect(first.getSnapshot()).toEqual(before);
    expect(reports(first)).toEqual(beforeReports);
    expect(first.getAuditEntriesForTests()).toEqual(beforeAudit);
    const other = second.getSnapshot();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const id of [...before.roster.map((player) => player.id), ...before.sessions.map((session) => session.id),
      ...beforeReports.flatMap((report) => report.matches.map((match) => match.id))]) expect(id).toMatch(uuid);
    expect(other.roster.map((player) => player.name)).toEqual(before.roster.map((player) => player.name));
    expect(other.roster.some((player) => before.roster.some((existing) => existing.id === player.id))).toBe(false);
    expect(other.sessions.some((session) => before.sessions.some((existing) => existing.id === session.id))).toBe(false);
    const matchIds = new Set(beforeReports.flatMap((report) => report.matches.map((match) => match.id)));
    expect(reports(second).some((report) => report.matches.some((match) => matchIds.has(match.id)))).toBe(false);
  });

  it.each(['roster', 'attendance ledger', 'completed history'] as const)(
    'preserves an existing private %s when seeding is requested', (state) => {
      const value = repository();
      const ids = ['Alex Wilkins', 'Sophie Nguyen', 'Jack Lawson', 'Grace Patel'].map((name) =>
        value.createPlayer({ name, skillLevel: 'intermediate', skillRating: 3.5,
          playStyle: 'Balanced' }).holdingPool.at(-1)!.id);
      if (state === 'completed history') {
        ids.forEach((id) => value.movePlayer(id, { type: 'court', courtId: 1 }));
        value.startGame(1);
        vi.mocked(Date.now).mockReturnValue(epoch + 60_000);
        value.endGame(1);
      }
      if (state !== 'roster') ids.forEach((id) => value.removePlayer(id));
      const before = value.getSnapshot();
      const beforeReports = reports(value);
      const beforeAudit = value.getAuditEntriesForTests();
      value.seedPublicFixture();
      expect(value.getSnapshot()).toEqual(before);
      expect(reports(value)).toEqual(beforeReports);
      expect(value.getAuditEntriesForTests()).toEqual(beforeAudit);
    },
  );

  it('preserves an empty closed private session', () => {
    const value = repository();
    const before = value.closeSession();
    const auditBefore = value.getAuditEntriesForTests();
    value.seedPublicFixture();
    expect(value.getSnapshot()).toEqual(before);
    expect(value.getAuditEntriesForTests()).toEqual(auditBefore);
  });
});
