import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import type { AppSnapshot, RosterImportRow } from '../src/models.js';

const repositories: Repository[] = [];
const apps: FastifyInstance[] = [];
const directories: string[] = [];
const key = 'session-membership-test-access-key';
const headers = { authorization: `Bearer ${key}` };
const configuration: AppConfig = {
  host: '127.0.0.1', port: 3001, operatorAccessKey: key,
  corsOrigins: ['http://localhost:5173'], databasePath: ':memory:',
  bodyLimit: 131_072, rateLimitMax: 10_000, rateLimitWindow: '1 minute', demoSeed: false,
};
const row = (externalId: string, name = externalId): RosterImportRow => ({
  externalId, name, skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced',
});
function repository(file = ':memory:') {
  const value = new Repository(file);
  repositories.push(value);
  return value;
}
async function appFor(value: Repository, publicDemo = false) {
  const app = await buildApp({ config: { ...configuration, publicDemo }, repository: value });
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  repositories.splice(0).forEach((value) => value.close());
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true }));
  vi.restoreAllMocks();
});

describe('session-specific roster membership', () => {
  it('opens empty, enrolls only submitted returning profiles, and carries only the last roster when requested', () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const value = repository();
    value.updateSettings({ ...value.getSettings(), gameMode: 'singles' });
    const imported = value.importRoster('Club roster', [row('alice'), row('bob')]).snapshot;
    const ids = imported.roster.map((player) => player.id);
    for (const id of ids) { value.setAttendance(id, 'ready'); value.movePlayer(id, { type: 'court', courtId: 1 }); }
    value.startGame(1);
    now += 65_000;
    value.endGame(1);
    value.closeSession();
    const archived = value.getSessionReport();
    const attendanceCsv = value.exportSession('attendance');
    expect(archived.participants.every((player) => player.checkedInAt !== null
      && player.gamesPlayed === 1 && player.playedSeconds === 65)).toBe(true);

    const empty = value.startSession('Tonight');
    expect(empty.roster).toEqual([]);
    expect(value.getSessionReport().totals.registeredPlayers).toBe(0);
    expect(value.getPlayerCount()).toBe(2);
    // Unrelated writes and closing the session must not enroll retained club profiles.
    value.toggleCourtStatus(2);
    expect(value.getSnapshot().roster).toEqual([]);
    const aliceId = imported.roster.find((player) => player.externalId === 'alice')!.id;
    const returning = value.importRoster('Club roster', [row('alice')]).snapshot;
    expect(returning.roster).toHaveLength(1);
    expect(returning.roster[0]).toMatchObject({ id: aliceId, attendance: 'expected', gamesPlayed: 0, playedSeconds: 0 });
    expect(value.getPlayerCount()).toBe(2);
    expect(value.getSessionReport().participants[0]?.checkedInAt).toBeNull();
    const withNewPlayer = value.createPlayer({ name: 'Charlie', skillLevel: 'unrated', skillRating: null, playStyle: 'Balanced' });
    const currentIds = withNewPlayer.roster.map((player) => player.id).sort();
    value.closeSession();
    const copied = value.startSession('Next week', true);
    expect(copied.roster.map((player) => player.id).sort()).toEqual(currentIds);
    expect(copied.roster.every((player) => player.attendance === 'expected'
      && player.gamesPlayed === 0 && player.playedSeconds === 0)).toBe(true);
    expect(value.getSessionReport().participants.every((player) => player.checkedInAt === null)).toBe(true);
    expect(value.getPlayerCount()).toBe(3);
    expect(value.getSessionReport(archived.session.id)).toEqual(archived);
    expect(value.exportSession('attendance', archived.session.id)).toBe(attendanceCsv);
  });

  it('rejects retained off-session IDs and excludes even stale ready profiles from current queues and courts', () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'sidecourt-membership-'));
    directories.push(directory);
    const file = path.join(directory, 'test.sqlite');
    const value = repository(file);
    const id = value.createPlayer({ name: 'Yesterday', skillLevel: 'intermediate', skillRating: 3.5,
      playStyle: 'Balanced' }).roster[0]!.id;
    value.closeSession();
    value.startSession('Today');
    const raw = new Database(file);
    try {
      expect(raw.prepare('SELECT attendance, location_type, court_id, waiting_since FROM players WHERE id = ?').get(id))
        .toEqual({ attendance: 'expected', location_type: 'holding-pool', court_id: null, waiting_since: null });
      raw.prepare("UPDATE players SET attendance = 'ready', waiting_since = 1 WHERE id = ?").run(id);
      const before = value.getSnapshot();
      const audits = value.getAuditEntriesForTests();
      expect(value.getHoldingCandidates()).toEqual([]);
      expect(value.createRotationPlan().assignments).toEqual([]);
      for (const mutate of [
        () => value.setAttendance(id, 'ready'),
        () => value.movePlayer(id, { type: 'court', courtId: 1 }),
        () => value.reorderHoldingPool(id, 0),
        () => value.removePlayer(id),
      ]) expect(mutate).toThrow('Player not found');
      expect(value.getSnapshot()).toEqual(before);
      // Rotation review has its own audit; rejected player mutations have none.
      expect(value.getAuditEntriesForTests().filter((entry) => String(entry.action).startsWith('player.')))
        .toEqual(audits.filter((entry) => String(entry.action).startsWith('player.')));
      raw.prepare("UPDATE players SET location_type = 'court', court_id = 1 WHERE id = ?").run(id);
      expect(value.getSnapshot().courts[0]!.players).toEqual([]);
      expect(() => value.startGame(1)).toThrow('exactly 4');
      value.toggleCourtStatus(2);
      expect(value.getSessionReport().participants).toEqual([]);
      expect(value.getPlayerCount()).toBe(1);
    } finally { raw.close(); }
  });

  it('strictly validates API carryover and defaults omitted carryover to an empty roster', async () => {
    const value = repository();
    value.createPlayer({ name: 'Alex', skillLevel: 'unrated', skillRating: null, playStyle: 'Balanced' });
    value.closeSession();
    const app = await appFor(value);
    for (const includePreviousRoster of ['true', 1, null]) {
      expect((await app.inject({ method: 'POST', url: '/api/sessions', headers,
        payload: { name: 'Invalid', includePreviousRoster } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/sessions', headers,
      payload: { name: 'Invalid', unknown: true } })).statusCode).toBe(400);
    const copied = await app.inject({ method: 'POST', url: '/api/sessions', headers,
      payload: { name: 'Carry roster', includePreviousRoster: true } });
    expect(copied.statusCode).toBe(201);
    expect(copied.json<AppSnapshot>().roster).toHaveLength(1);
    value.closeSession();
    const empty = await app.inject({ method: 'POST', url: '/api/sessions', headers, payload: { name: 'Start empty' } });
    expect(empty.statusCode).toBe(201);
    expect(empty.json<AppSnapshot>().roster).toEqual([]);
    expect(value.getPlayerCount()).toBe(1);
  });

  it('counts retained profiles toward the public cap after opening an empty session', async () => {
    const app = await appFor(repository(), true);
    const visitor = await app.inject({ method: 'POST', url: '/api/visitor-sessions' });
    const visitorHeaders = { authorization: `Bearer ${visitor.json<{ accessKey: string }>().accessKey}` };
    const state = (await app.inject({ method: 'GET', url: '/api/state', headers: visitorHeaders })).json<AppSnapshot>();
    for (const court of state.courts.filter((item) => item.status === 'in-play')) {
      expect((await app.inject({ method: 'POST', url: `/api/courts/${court.id}/end`, headers: visitorHeaders })).statusCode).toBe(200);
    }
    const remaining = 500 - state.roster.length;
    for (let offset = 0; offset < remaining; offset += 200) {
      const response = await app.inject({ method: 'POST', url: '/api/roster/import', headers: visitorHeaders,
        payload: { source: 'capacity', rows: Array.from({ length: Math.min(200, remaining - offset) }, (_, index) => row(`capacity-${offset + index}`)) } });
      expect(response.statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'POST', url: '/api/sessions/close', headers: visitorHeaders })).statusCode).toBe(200);
    const started = await app.inject({ method: 'POST', url: '/api/sessions', headers: visitorHeaders, payload: { name: 'Empty at capacity' } });
    expect(started.json<AppSnapshot>().roster).toEqual([]);
    const additional = await app.inject({ method: 'POST', url: '/api/players', headers: visitorHeaders,
      payload: { name: 'Overflow', skillLevel: 'unrated', skillRating: null, playStyle: 'Balanced' } });
    expect(additional.statusCode).toBe(409);
    expect(additional.json().error.code).toBe('ROSTER_LIMIT');
    const newImport = await app.inject({ method: 'POST', url: '/api/roster/import', headers: visitorHeaders,
      payload: { source: 'capacity', rows: [row('overflow')] } });
    expect(newImport.statusCode).toBe(409);
    expect(newImport.json().error.code).toBe('ROSTER_LIMIT');
    const returning = await app.inject({ method: 'POST', url: '/api/roster/import', headers: visitorHeaders,
      payload: { source: 'capacity', rows: [row('capacity-0')] } });
    expect(returning.statusCode).toBe(200);
    expect(returning.json<{ snapshot: AppSnapshot }>().snapshot.roster).toHaveLength(1);
  });
});
