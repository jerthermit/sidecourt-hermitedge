import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../src/db.js';

const repositories: Repository[] = [];
const directories: string[] = [];
const at = (value: string) => vi.mocked(Date.now).mockReturnValue(Date.parse(value));
const repository = (file = ':memory:') => {
  const value = new Repository(file); repositories.push(value); return value;
};
const players = (value: Repository) => ['Alex', 'Blair', 'Casey', 'Drew'].map((name) =>
  value.createPlayer({ name, skillLevel: 'unrated', skillRating: null, playStyle: 'Balanced' }).holdingPool.at(-1)!.id);
const complete = (value: Repository, ids: string[], start: string, seconds = 60) => {
  at(start);
  for (const id of ids) value.movePlayer(id, { type: 'court', courtId: 1 });
  value.startGame(1);
  vi.mocked(Date.now).mockReturnValue(Date.now() + seconds * 1000);
  return value.endGame(1).gameHistory.find((match) => match.startedAt === Date.parse(start))!;
};

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-03T12:00:00Z')); });
afterEach(() => {
  repositories.splice(0).forEach((value) => value.close());
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true }));
  vi.restoreAllMocks();
});

describe('daily recorded owner reports', () => {
  it('returns a read-only empty date without inventing utilization or business outcomes', () => {
    const value = repository();
    const before = value.getSnapshot();
    const audit = value.getAuditEntriesForTests();
    expect(value.getDailyReport('2026-10-02')).toEqual({ date: '2026-10-02',
      displayTimezone: 'Australia/Sydney', generatedAt: Date.now(),
      totals: { checkedInPlayers: 0, completedMatches: 0, voidedMatches: 0,
        correctedMatches: 0, completedCourtSeconds: 0 }, courts: [], sessions: [], matches: [] });
    expect(value.getSnapshot()).toEqual(before);
    expect(value.getAuditEntriesForTests()).toEqual(audit);
  });

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-01', '2026-1-01',
    '2026-01-1', '0000-01-01', '2026-01-01T00:00:00Z', ' 2026-01-01', ''])('rejects invalid calendar date %j', (date) => {
    const value = repository();
    expect(() => value.getDailyReport(date)).toThrow(expect.objectContaining({ statusCode: 400, code: 'INVALID_REQUEST' }));
  });

  it('groups by Sydney local start date across the 23-hour DST day and midnight, retaining full duration', () => {
    const value = repository();
    const ids = players(value);
    const before = complete(value, ids, '2026-10-03T13:59:50Z', 20);
    const first = complete(value, ids, '2026-10-03T14:00:20Z', 60);
    const jump = complete(value, ids, '2026-10-03T15:59:00Z', 120);
    const midnight = complete(value, ids, '2026-10-04T12:59:50Z', 20);
    const after = complete(value, ids, '2026-10-04T13:00:10Z', 60);
    const report = value.getDailyReport('2026-10-04');
    expect(report.matches.map((match) => match.id)).toEqual([first.id, jump.id, midnight.id]);
    expect(report.totals).toMatchObject({ completedMatches: 3, completedCourtSeconds: 200 });
    expect(value.getDailyReport('2026-10-03').matches.map((match) => match.id)).toEqual([before.id]);
    expect(value.getDailyReport('2026-10-05').matches.map((match) => match.id)).toEqual([after.id]);
    // Reports use current configured timezone rather than pretending settings were archived.
    value.updateSettings({ ...value.getSettings(), timezone: 'Asia/Manila' });
    const philippines = value.getDailyReport('2026-10-04');
    expect(philippines.displayTimezone).toBe('Asia/Manila');
    expect(philippines.matches.map((match) => match.id)).toEqual([midnight.id, after.id]);
    expect(philippines.totals.completedCourtSeconds).toBe(80);
  });

  it('includes both occurrences of the repeated hour on Sydney’s 25-hour DST day', () => {
    at('2026-04-04T12:00:00Z');
    const value = repository();
    const ids = players(value);
    const first = complete(value, ids, '2026-04-04T13:00:00Z');
    const repeatedA = complete(value, ids, '2026-04-04T15:30:00Z');
    const repeatedB = complete(value, ids, '2026-04-04T16:30:00Z');
    const last = complete(value, ids, '2026-04-05T13:59:00Z');
    const next = complete(value, ids, '2026-04-05T14:01:00Z');
    expect(value.getDailyReport('2026-04-05').matches.map((match) => match.id))
      .toEqual([first.id, repeatedA.id, repeatedB.id, last.id]);
    expect(value.getDailyReport('2026-04-06').matches.map((match) => match.id)).toEqual([next.id]);
  });

  it('counts completed corrections separately from voids and preserves recorded match identities and court names', () => {
    at('2026-10-04T00:00:00Z');
    const value = repository();
    value.updateSettings({ ...value.getSettings(), courtNames: ['Garden', 'Terrace', 'East', 'West', 'North', 'South'] });
    const ids = players(value);
    const corrected = complete(value, ids, '2026-10-04T00:01:00Z');
    value.correctRecordedGame(corrected.id, { playerIds: ids, durationSeconds: 30, reason: 'Correct timer' });
    const voided = complete(value, ids, '2026-10-04T00:03:00Z', 90);
    value.voidRecordedGame(voided.id, 'Duplicate record');
    at('2026-10-04T00:06:00Z');
    for (const id of ids) value.movePlayer(id, { type: 'court', courtId: 1 });
    value.startGame(1);
    at('2026-10-04T00:06:10Z');
    value.voidActiveGame(1, 'Accidental start');
    value.removePlayer(ids[0]!);
    value.updateSettings({ ...value.getSettings(), courtNames: ['Renamed', 'Terrace', 'East', 'West', 'North', 'South'] });
    const report = value.getDailyReport('2026-10-04');
    expect(report.totals).toEqual({ checkedInPlayers: 4, completedMatches: 1,
      voidedMatches: 2, correctedMatches: 1, completedCourtSeconds: 30 });
    expect(report.courts).toEqual([{ courtId: 1, courtName: 'Garden', completedMatches: 1,
      completedCourtSeconds: 30, voidedMatches: 2, correctedMatches: 1 }]);
    expect(report.matches).toHaveLength(3);
    expect(report.matches[0]).toMatchObject({ id: corrected.id, playerIds: ids,
      players: ['Alex', 'Blair', 'Casey', 'Drew'], courtName: 'Garden', duration: 30 });
    expect(report.matches[1]).toMatchObject({ id: voided.id, status: 'voided', reason: 'Duplicate record' });
    expect(report.matches[2]).toMatchObject({ status: 'voided', reason: 'Accidental start' });
  });

  it('counts a returning identity once across sessions and includes sessions by opening, attendance or match date', () => {
    at('2026-10-03T12:00:00Z');
    const value = repository();
    const ids = players(value);
    const previous = value.getSnapshot().session;
    complete(value, ids, '2026-10-03T14:10:00Z');
    value.closeSession();
    at('2026-10-03T14:20:00Z');
    const morning = value.startSession('Morning', true).session;
    for (const id of ids) value.setAttendance(id, 'ready');
    value.closeSession();
    at('2026-10-03T16:00:00Z');
    const evening = value.startSession('Evening', true).session;
    for (const id of ids) value.setAttendance(id, 'ready');
    value.closeSession();
    at('2026-10-04T13:10:00Z');
    const following = value.startSession('Following day').session;
    const report = value.getDailyReport('2026-10-04');
    expect(report.totals.checkedInPlayers).toBe(4);
    expect(report.sessions.map((session) => session.id)).toEqual([previous.id, morning.id, evening.id]);
    expect(report.sessions.some((session) => session.id === following.id)).toBe(false);
    expect(report.matches).toHaveLength(1);
  });

  it('does not expire pending reviews, mutate audits or count active play while reading', () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'sidecourt-daily-report-'));
    directories.push(directory);
    const file = path.join(directory, 'fictional.sqlite');
    at('2026-10-04T00:00:00Z');
    const value = repository(file);
    const ids = players(value);
    const context = value.getMatchContext();
    const proposal = value.persistProposal({ source: 'rules-fallback', notice: '',
      playerIds: context.candidates.map((player) => player.id), contextRevision: context.revision });
    at('2026-10-04T00:10:00Z');
    const audit = value.getAuditEntriesForTests();
    expect(value.getDailyReport('2026-10-04').totals.completedMatches).toBe(0);
    expect(value.getAuditEntriesForTests()).toEqual(audit);
    const raw = new Database(file);
    try { expect(raw.prepare('SELECT status FROM match_proposals WHERE id = ?').pluck().get(proposal.id)).toBe('pending'); }
    finally { raw.close(); }
    for (const id of ids) value.movePlayer(id, { type: 'court', courtId: 1 });
    value.startGame(1);
    expect(value.getDailyReport('2026-10-04').matches).toEqual([]);
  });

  it('reads every stored match and session rather than snapshot history limits', () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'sidecourt-daily-history-'));
    directories.push(directory);
    const file = path.join(directory, 'fictional.sqlite');
    at('2026-10-04T00:00:00Z');
    const value = repository(file);
    const ids = players(value);
    const original = complete(value, ids, '2026-10-04T00:01:00Z');
    const raw = new Database(file);
    try {
      const session = raw.prepare('INSERT INTO sessions (id, name, started_at, ended_at) VALUES (?, ?, ?, ?)');
      const history = raw.prepare(`INSERT INTO game_history
        (id, session_id, court_id, court_name, player_names_json, player_ids_json, started_at, ended_at, duration, status)
        VALUES (?, ?, 1, 'Garden', ?, ?, ?, ?, 60, 'completed')`);
      raw.transaction(() => {
        for (let index = 0; index < 240; index += 1) {
          const id = `stored-session-${index}`;
          session.run(id, `Session ${index}`, original.startedAt, original.endedAt);
          history.run(`stored-match-${index.toString().padStart(3, '0')}`, id,
            JSON.stringify(original.players), JSON.stringify(ids), original.startedAt, original.endedAt);
        }
      })();
    } finally { raw.close(); }
    const report = value.getDailyReport('2026-10-04');
    expect(report.matches).toHaveLength(241);
    expect(report.sessions).toHaveLength(241);
    expect(report.totals.completedMatches).toBe(241);
    expect(report.totals.completedCourtSeconds).toBe(241 * 60);
    expect(report.matches.every((match) => match.playerIds.join(',') === ids.join(','))).toBe(true);
  });
});
