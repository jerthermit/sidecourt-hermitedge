import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../src/db.js';

const repositories: Repository[] = [];
const directories: string[] = [];
const epoch = 1_800_000_000_000;
const repository = (file = ':memory:') => {
  const value = new Repository(file); repositories.push(value); return value;
};
const fileForTest = () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'sidecourt-session-report-'));
  directories.push(directory); return path.join(directory, 'fictional.sqlite');
};
const add = (value: Repository, name: string) => value.createPlayer({
  name, skillLevel: 'unrated', skillRating: null, playStyle: 'Balanced',
}).holdingPool.at(-1)!.id;
const complete = (value: Repository, ids: string[], seconds = 60) => {
  for (const id of ids) value.movePlayer(id, { type: 'court', courtId: 1 });
  value.startGame(1);
  vi.mocked(Date.now).mockReturnValue(Date.now() + seconds * 1000);
  return value.endGame(1).gameHistory[0]!;
};

afterEach(() => {
  repositories.splice(0).forEach((value) => value.close());
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true }));
  vi.restoreAllMocks();
});

describe('authoritative session reports', () => {
  it('returns an honest empty current session without business-outcome or historical-setting claims', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const value = repository();
    const report = value.getSessionReport();
    expect(report.generatedAt).toBe(epoch);
    expect(report.session).toEqual(value.getSnapshot().session);
    expect(report.displayTimezone).toBe('Australia/Sydney');
    expect(report.participants).toEqual([]);
    expect(report.matches).toEqual([]);
    expect(report.activeMatches).toBe(0);
    expect(report.totals).toEqual({ registeredPlayers: 0, checkedInPlayers: 0,
      completedMatches: 0, voidedMatches: 0, correctedMatches: 0,
      completedCourtSeconds: 0, unattributedCompletedMatches: 0 });
    expect(report).not.toHaveProperty('settings');
    expect(report).not.toHaveProperty('savings');
    expect(report).not.toHaveProperty('averageWait');
  });

  it('distinguishes imported registration from actual first check-in and retains a departed arrival', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const value = repository();
    const imported = value.importRoster(' permitted-roster ', ['Alex', 'Blair'].map((name, index) => ({
      externalId: `club-${index}`, name, skillLevel: 'unrated' as const,
      skillRating: null, playStyle: 'Balanced' as const,
    })));
    const alex = imported.snapshot.roster.find((player) => player.name === 'Alex')!.id;
    vi.mocked(Date.now).mockReturnValue(epoch + 10_000);
    value.setAttendance(alex, 'ready');
    value.setAttendance(alex, 'resting');
    vi.mocked(Date.now).mockReturnValue(epoch + 20_000);
    value.setAttendance(alex, 'ready');
    value.setAttendance(alex, 'departed');
    const report = value.getSessionReport();
    expect(report.totals).toMatchObject({ registeredPlayers: 2, checkedInPlayers: 1 });
    expect(report.participants.find((player) => player.id === alex)).toMatchObject({
      name: 'Alex', source: 'permitted-roster', externalId: 'club-0', attendance: 'departed',
      checkedInAt: epoch + 10_000, gamesPlayed: 0, playedSeconds: 0,
    });
    expect(report.participants.find((player) => player.name === 'Blair')).toMatchObject({
      attendance: 'expected', checkedInAt: null,
    });
  });

  it('retains removed participants and distinct identities with the same name', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const value = repository();
    const ids = ['Same name', 'Same name', 'Casey', 'Drew'].map((name) => add(value, name));
    complete(value, ids, 65);
    value.removePlayer(ids[0]!);
    const report = value.getSessionReport();
    expect(report.totals).toMatchObject({ registeredPlayers: 4, checkedInPlayers: 4,
      completedMatches: 1, completedCourtSeconds: 65, unattributedCompletedMatches: 0 });
    expect(report.participants.filter((player) => player.name === 'Same name')).toHaveLength(2);
    expect(report.participants.find((player) => player.id === ids[0])).toMatchObject({
      attendance: 'departed', gamesPlayed: 1, playedSeconds: 65,
    });
    expect(report.matches[0]!.playerIds).toEqual(ids);
    expect(report.participants.every((player) => player.gamesPlayed === 1 && player.playedSeconds === 65)).toBe(true);
  });

  it('uses corrected participants and duration with recalculated ledger values', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const value = repository();
    const ids = ['Alex', 'Blair', 'Casey', 'Drew', 'Eden'].map((name) => add(value, name));
    const match = complete(value, ids.slice(0, 4));
    value.removePlayer(ids[4]!);
    const corrected = [ids[0]!, ids[1]!, ids[2]!, ids[4]!];
    value.correctRecordedGame(match.id, { playerIds: corrected,
      durationSeconds: 30, reason: 'Correct participants and clock' });
    const report = value.getSessionReport();
    expect(report.totals).toMatchObject({ completedMatches: 1, correctedMatches: 1,
      completedCourtSeconds: 30, voidedMatches: 0, unattributedCompletedMatches: 0 });
    expect(report.matches[0]).toMatchObject({ playerIds: corrected, duration: 30,
      reason: 'Correct participants and clock', correctedAt: epoch + 60_000 });
    expect(report.participants.find((player) => player.id === ids[3])).toMatchObject({ gamesPlayed: 0, playedSeconds: 0 });
    expect(report.participants.find((player) => player.id === ids[4])).toMatchObject({ gamesPlayed: 1, playedSeconds: 30 });
  });

  it('keeps active and recorded voids separate from completed time, corrections and player games', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const value = repository();
    const ids = ['Alex', 'Blair', 'Casey', 'Drew'].map((name) => add(value, name));
    const match = complete(value, ids);
    value.voidRecordedGame(match.id, 'Duplicate completion');
    for (const id of ids) value.movePlayer(id, { type: 'court', courtId: 1 });
    value.startGame(1);
    vi.mocked(Date.now).mockReturnValue(epoch + 70_000);
    value.voidActiveGame(1, 'Accidental start');
    const report = value.getSessionReport();
    expect(report.activeMatches).toBe(0);
    expect(report.totals).toMatchObject({ completedMatches: 0, voidedMatches: 2,
      correctedMatches: 0, completedCourtSeconds: 0, unattributedCompletedMatches: 0 });
    expect(report.matches.map((row) => row.reason)).toEqual(['Duplicate completion', 'Accidental start']);
    expect(report.participants.every((player) => player.gamesPlayed === 0 && player.playedSeconds === 0)).toBe(true);
  });

  it('reads active play without counting unfinished games, expiring pending reviews or adding audits', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const file = fileForTest();
    const value = repository(file);
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name) => add(value, name));
    for (const id of ids.slice(0, 4)) value.movePlayer(id, { type: 'court', courtId: 1 });
    value.startGame(1);
    const context = value.getMatchContext();
    const review = value.persistProposal({ source: 'rules-fallback', notice: '',
      playerIds: context.candidates.map((player) => player.id), contextRevision: context.revision });
    const beforeAudits = value.getAuditEntriesForTests();
    vi.mocked(Date.now).mockReturnValue(review.expiresAt + 1);
    const report = value.getSessionReport();
    expect(report.activeMatches).toBe(1);
    expect(report.totals.completedMatches).toBe(0);
    expect(report.totals.completedCourtSeconds).toBe(0);
    expect(report.participants.every((player) => player.gamesPlayed === 0 && player.playedSeconds === 0)).toBe(true);
    expect(value.getAuditEntriesForTests()).toEqual(beforeAudits);
    const raw = new Database(file);
    try {
      expect(raw.prepare('SELECT status FROM match_proposals WHERE id = ?').pluck().get(review.id)).toBe('pending');
    } finally { raw.close(); }
  });

  it('reopens a durable archive with recorded identities/courts and no leakage from the active session', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const file = fileForTest();
    const value = repository(file);
    value.updateSettings({ ...value.getSettings(), courtCount: 2, courtNames: ['Garden', 'Terrace'] });
    const ids = ['Alex', 'Blair', 'Casey', 'Drew'].map((name) => add(value, name));
    complete(value, ids);
    value.closeSession();
    const archived = value.getSessionReport();
    vi.mocked(Date.now).mockReturnValue(epoch + 120_000);
    value.startSession('Next club session', true);
    value.updateSettings({ ...value.getSettings(), timezone: 'Australia/Perth', courtNames: ['North', 'South'] });
    for (const id of ids) { value.setAttendance(id, 'ready'); value.movePlayer(id, { type: 'court', courtId: 1 }); }
    value.startGame(1);
    value.close();
    const raw = new Database(file);
    try { raw.prepare('UPDATE players SET name = ? WHERE id = ?').run('Changed current name', ids[0]!); }
    finally { raw.close(); }
    const reopened = repository(file);
    const report = reopened.getSessionReport(archived.session.id);
    expect(report.participants).toEqual(archived.participants);
    expect(report.matches).toEqual(archived.matches);
    expect(report.totals).toEqual(archived.totals);
    expect(report.session).toEqual(archived.session);
    expect(report.activeMatches).toBe(0);
    expect(report.matches[0]!.courtName).toBe('Garden');
    expect(report.matches[0]!.players[0]).toBe('Alex');
    expect(report.displayTimezone).toBe('Australia/Perth');
    expect(reopened.getSessionReport().activeMatches).toBe(1);
    expect(reopened.getSnapshot().roster.find((player) => player.id === ids[0])!.name).toBe('Changed current name');
  });

  it('exposes legacy/unattributed records without guessing player identities or rewriting their ledger', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const file = fileForTest();
    const value = repository(file);
    const ids = ['Alex', 'Blair', 'Casey', 'Drew'].map((name) => add(value, name));
    const legacy = complete(value, ids);
    const partial = complete(value, ids);
    value.close();
    const raw = new Database(file);
    try {
      raw.prepare('UPDATE game_history SET player_ids_json = ? WHERE id = ?').run('[]', legacy.id);
      raw.prepare('UPDATE game_history SET player_ids_json = ? WHERE id = ?')
        .run(JSON.stringify([ids[0], ids[1], ids[2], 'unknown-original-identity']), partial.id);
    } finally { raw.close(); }
    const report = repository(file).getSessionReport();
    expect(report.totals).toMatchObject({ completedMatches: 2,
      completedCourtSeconds: 120, unattributedCompletedMatches: 2 });
    expect(report.matches.find((match) => match.id === legacy.id)!.playerIds).toEqual([]);
    expect(report.matches.find((match) => match.id === legacy.id)!.players).toEqual(['Alex', 'Blair', 'Casey', 'Drew']);
    expect(report.matches.find((match) => match.id === partial.id)!.playerIds.at(-1)).toBe('unknown-original-identity');
    expect(report.participants.every((participant) => participant.gamesPlayed === 2)).toBe(true);
  });

  it('rejects an unknown session without returning another session as a fallback', () => {
    const value = repository();
    expect(() => value.getSessionReport('00000000-0000-4000-8000-000000000000')).toThrow(
      expect.objectContaining({ statusCode: 404, code: 'NOT_FOUND', message: 'Session not found.' }),
    );
  });
});
