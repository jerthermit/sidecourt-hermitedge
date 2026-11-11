import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { Repository } from '../src/db.js';
import type { RosterImportRow } from '../src/models.js';
import { publicRoster } from '../src/publicFixture.js';

const repositories: Repository[] = [];
const apps: FastifyInstance[] = [];
const key = 'roster-correction-test-key-123456';
const row = (externalId: string, name = `Member ${externalId}`): RosterImportRow => ({
  externalId, name, skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced',
});
const open = () => {
  const repository = new Repository(':memory:');
  repositories.push(repository);
  return repository;
};
// Deliberately manufacture historical casing problems in isolated in-memory fixtures.
const database = (repository: Repository) => (repository as unknown as { db: Database.Database }).db;
const globalCount = (repository: Repository) => database(repository).prepare('SELECT COUNT(*) FROM players').pluck().get();
const ids = (repository: Repository) => repository.getSnapshot().roster.map((player) => player.id).sort();
const complete = (repository: Repository, playerIds: string[]) => {
  for (const id of playerIds) {
    repository.setAttendance(id, 'ready');
    repository.movePlayer(id, { type: 'court', courtId: 1 });
  }
  repository.startGame(1);
  vi.mocked(Date.now).mockReturnValue(Date.now() + 60_000);
  repository.endGame(1);
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  repositories.splice(0).forEach((repository) => repository.close());
  vi.restoreAllMocks();
});

describe('roster import identity and reviewed corrections', () => {
  it('reimports all 96 seeded profiles through case variants without creating new identities', () => {
    const repository = open();
    repository.seedPublicFixture();
    expect(repository.getSnapshot().roster.every((player) => player.source === 'club roster')).toBe(true);
    const beforeIds = ids(repository);
    const audit = repository.getAuditEntriesForTests();
    const revision = repository.getMatchContext().revision;
    // The former seed used title case; source whitespace must also be tolerated.
    database(repository).prepare('UPDATE players SET source = ?').run(' Club roster ');
    const preview = repository.previewRosterImport(' CLUB ROSTER ', publicRoster);
    expect(preview).toMatchObject({ newCount: 0, existingCount: 96, conflictCount: 0, enrollCount: 0 });
    expect(repository.importRoster('club roster', publicRoster)).toMatchObject({
      added: 0, skipped: 96, updated: 0, enrolled: 0,
    });
    expect(ids(repository)).toEqual(beforeIds);
    expect(globalCount(repository)).toBe(96);
    expect(repository.getMatchContext().revision).toBe(revision);
    expect(repository.getAuditEntriesForTests()).toEqual(audit);
  });

  it('applies reviewed profile corrections in place while preserving current and archived match identities', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const repository = open();
    const rows = ['a', 'b', 'c', 'd'].map((id) => row(id));
    const imported = repository.importRoster('club', rows);
    const playerIds = imported.snapshot.roster.map((player) => player.id);
    const correctedId = imported.snapshot.roster.find((player) => player.externalId === 'a')!.id;
    complete(repository, playerIds);
    const archivedSessionId = repository.closeSession().session.id;
    const archived = repository.getSessionReport(archivedSessionId);
    repository.startSession('Next social', true);
    complete(repository, playerIds);
    const before = repository.getSnapshot();
    const originalPlayer = before.roster.find((player) => player.id === correctedId)!;
    const plan = repository.createRotationPlan();
    const changed = { ...rows[0]!, name: 'Corrected member', skillLevel: 'advanced' as const,
      skillRating: 4.6, playStyle: 'Tactical' as const };
    const preview = repository.previewRosterImport('CLUB', [changed]);
    expect(preview.rows[0]).toMatchObject({ status: 'conflict', canUpdate: true,
      current: { name: rows[0]!.name, skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced' } });
    expect(preview.conflictCount).toBe(1);
    expect(() => repository.importRoster('club', [changed])).toThrow('conflicts');
    const result = repository.importRoster('club', [changed], { updateExisting: true, revision: preview.revision });
    expect(result).toMatchObject({ added: 0, skipped: 0, updated: 1, enrolled: 0 });
    expect(result.snapshot.roster).toHaveLength(4);
    expect(result.snapshot.roster.find((player) => player.id === correctedId)).toMatchObject({
      ...changed, id: correctedId, gamesPlayed: originalPlayer.gamesPlayed,
      playedSeconds: originalPlayer.playedSeconds, createdAt: originalPlayer.createdAt,
      attendance: originalPlayer.attendance, location: originalPlayer.location,
    });
    expect(result.snapshot.gameHistory).toEqual(before.gameHistory);
    expect(repository.getSessionReport().participants.find((player) => player.id === correctedId))
      .toMatchObject({ name: changed.name, gamesPlayed: 1, playedSeconds: 60 });
    expect(repository.getSessionReport(archivedSessionId)).toEqual({ ...archived, generatedAt: Date.now() });
    expect(repository.getCurrentRotationPlan()).toBeNull();
    expect(() => repository.applyRotationPlan(plan.id)).toThrow();
    expect(repository.getAuditEntriesForTests().filter((entry) => entry.action === 'roster.profile.updated'))
      .toHaveLength(1);
    const revision = repository.getMatchContext().revision;
    const audits = repository.getAuditEntriesForTests();
    expect(repository.importRoster('club', [changed])).toMatchObject({ added: 0, skipped: 1, updated: 0, enrolled: 0 });
    expect(repository.getMatchContext().revision).toBe(revision);
    expect(repository.getAuditEntriesForTests()).toEqual(audits);
  });

  it('enrolls known identities into a new empty session and never withdraws omitted players', () => {
    const repository = open();
    const rows = ['a', 'b', 'c'].map((id) => row(id));
    const original = repository.importRoster('club', rows).snapshot;
    const originalIds = original.roster.map((player) => player.id).sort();
    const archivedId = repository.closeSession().session.id;
    repository.startSession('Empty social');
    expect(repository.getSnapshot().roster).toEqual([]);
    const changed = { ...rows[1]!, name: 'Corrected on arrival' };
    const preview = repository.previewRosterImport(' CLUB ', [rows[0]!, changed]);
    expect(preview).toMatchObject({ newCount: 0, existingCount: 1, conflictCount: 1, enrollCount: 2 });
    const result = repository.importRoster('club', [rows[0]!, changed], { updateExisting: true, revision: preview.revision });
    expect(result).toMatchObject({ added: 0, skipped: 0, updated: 1, enrolled: 2 });
    expect(result.snapshot.roster).toHaveLength(2);
    expect(result.snapshot.roster.every((player) => player.attendance === 'expected' && player.gamesPlayed === 0)).toBe(true);
    expect(repository.importRoster('club', [rows[2]!])).toMatchObject({ added: 0, skipped: 0, updated: 0, enrolled: 1 });
    expect(ids(repository)).toEqual(originalIds);
    expect(repository.importRoster('club', [rows[2]!])).toMatchObject({ added: 0, skipped: 1, enrolled: 0 });
    expect(ids(repository)).toEqual(originalIds);
    expect(repository.getSessionReport(archivedId).participants.map((player) => player.name).sort())
      .toEqual(rows.map((player) => player.name).sort());
  });

  it('rejects a stale or missing review revision atomically, including any new rows', () => {
    const repository = open();
    const original = row('a');
    const id = repository.importRoster('club', [original]).snapshot.roster[0]!.id;
    const rows = [row('new'), { ...original, name: 'Reviewed change' }];
    const preview = repository.previewRosterImport('club', rows);
    repository.setAttendance(id, 'ready');
    const before = repository.getSnapshot();
    const audit = repository.getAuditEntriesForTests();
    const revision = repository.getMatchContext().revision;
    for (const options of [{ updateExisting: true }, { updateExisting: true, revision: preview.revision }]) {
      expect(() => repository.importRoster('club', rows, options)).toThrow('Review the import again');
      expect(repository.getSnapshot()).toEqual(before);
      expect(repository.getAuditEntriesForTests()).toEqual(audit);
      expect(repository.getMatchContext().revision).toBe(revision);
      expect(globalCount(repository)).toBe(1);
    }
  });

  it('blocks corrections for active players and invalid submitted profiles atomically', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const repository = open();
    const rows = ['a', 'b', 'c', 'd'].map((id) => row(id));
    const imported = repository.importRoster('club', rows);
    for (const player of imported.snapshot.roster) {
      repository.setAttendance(player.id, 'ready');
      repository.movePlayer(player.id, { type: 'court', courtId: 1 });
    }
    repository.startGame(1);
    const submitted = [row('new'), { ...rows[0]!, skillRating: 4 }];
    const preview = repository.previewRosterImport('club', submitted);
    expect(preview.rows[1]).toMatchObject({ status: 'conflict', canUpdate: false });
    const before = repository.getSnapshot();
    const audit = repository.getAuditEntriesForTests();
    expect(() => repository.importRoster('club', submitted, { updateExisting: true, revision: preview.revision }))
      .toThrow('conflicts');
    expect(() => repository.importRoster('club', [row('new'), { ...rows[0]!, skillRating: 7 }],
      { updateExisting: true, revision: preview.revision })).toThrow('invalid player details');
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(audit);
    expect(globalCount(repository)).toBe(4);
  });

  it('reports old source-case collisions as uneditable conflicts even when one profile matches', () => {
    const repository = open();
    const original = row('a');
    const existing = repository.importRoster('club', [original]).snapshot.roster[0]!;
    database(repository).prepare(`INSERT INTO players
      (id,name,skill_level,skill_rating,play_style,attendance,source,external_id,
       location_type,next_lane,position,court_id,created_at)
      SELECT ?,name,skill_level,skill_rating,play_style,attendance,?,external_id,
       location_type,next_lane,position,court_id,created_at FROM players WHERE id = ?`)
      .run('legacy-case-collision', ' Club ', existing.id);
    const preview = repository.previewRosterImport('CLUB', [row('new'), original]);
    expect(preview).toMatchObject({ newCount: 1, existingCount: 0, conflictCount: 1, enrollCount: 0 });
    expect(preview.rows[1]).toMatchObject({ status: 'conflict', canUpdate: false });
    expect(preview.rows[1]!.current).toBeUndefined();
    const before = repository.getSnapshot();
    const audit = repository.getAuditEntriesForTests();
    expect(() => repository.importRoster('club', [row('new'), original],
      { updateExisting: true, revision: preview.revision })).toThrow('conflicts');
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(audit);
    expect(globalCount(repository)).toBe(2);
  });

  it('accepts explicit reviewed corrections only on the strict import endpoint', async () => {
    const repository = open();
    const app = await buildApp({ repository, config: {
      host: '127.0.0.1', port: 3001, operatorAccessKey: key, corsOrigins: ['http://localhost:5173'],
      databasePath: ':memory:', bodyLimit: 65_536, rateLimitMax: 10_000, rateLimitWindow: '1 minute', demoSeed: false,
    } });
    apps.push(app);
    const original = row('a');
    repository.importRoster('club', [original]);
    const rows = [{ ...original, name: 'Confirmed correction' }];
    const request = (operation: string, payload: unknown) => app.inject({
      method: 'POST', url: `/api/roster/${operation}`, headers: { authorization: `Bearer ${key}` }, payload,
    });
    const preview = (await request('preview', { source: 'club', rows })).json<{ revision: number }>();
    const before = repository.getSnapshot();
    const audit = repository.getAuditEntriesForTests();
    for (const invalid of [{ updateExisting: 'yes' }, { revision: -1 }, { revision: 1.5 },
      { revision: '1' }, { unknown: true }, { rows: [{ ...rows[0], canUpdate: true }] }]) {
      expect((await request('import', { source: 'club', rows, ...invalid })).statusCode).toBe(400);
    }
    expect((await request('preview', { source: 'club', rows, updateExisting: true })).statusCode).toBe(400);
    expect((await request('import', { source: 'club', rows, updateExisting: true })).statusCode).toBe(409);
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(audit);
    const response = await request('import', { source: 'club', rows, updateExisting: true, revision: preview.revision });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ added: 0, skipped: 0, updated: 1, enrolled: 0 });
  });
});
