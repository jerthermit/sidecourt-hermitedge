import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import type { AppSnapshot, RotationPlan } from '../src/models.js';

const key = 'court-capacity-test-key-123456';
const repositories: Repository[] = [];
const apps: FastifyInstance[] = [];
const directories: string[] = [];
const names = (count: number) => Array.from({ length: count }, (_, index) => `Venue ${index + 1}`);
const post = (app: FastifyInstance, url: string, payload: unknown = {}) => app.inject({
  method: 'POST', url, payload, headers: { authorization: `Bearer ${key}` },
});
function repository(location = ':memory:') {
  const value = new Repository(location);
  repositories.push(value);
  return value;
}
async function open() {
  const value = repository();
  const app = await buildApp({ repository: value, config: loadConfig({
    OPERATOR_ACCESS_KEY: key, DATABASE_PATH: ':memory:', RATE_LIMIT_MAX: '10000',
  }) });
  apps.push(app);
  return { app, value };
}
function add(value: Repository, count: number) {
  for (let index = 0; index < count; index += 1) value.createPlayer({
    name: `Capacity player ${index + 1}`, skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced',
  });
  return value.getSnapshot().holdingPool.map((player) => player.id);
}
function file() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'sidecourt-capacity-'));
  directories.push(directory);
  return path.join(directory, 'board.db');
}

// Build an actual constrained v5 database, including both six-court CHECKs.
function downgradeToV5(location: string) {
  const raw = new Database(location);
  try {
    raw.pragma('foreign_keys = OFF');
    raw.transaction(() => {
      raw.prepare('DELETE FROM courts WHERE id > 6').run();
      for (const table of ['courts', 'club_settings']) {
        const { sql } = raw.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string };
        raw.exec(sql.replace(new RegExp(`^CREATE TABLE (?:"${table}"|${table})`), `CREATE TABLE ${table}_v5`)
          .replace('BETWEEN 1 AND 16', 'BETWEEN 1 AND 6'));
        raw.exec(`INSERT INTO ${table}_v5 SELECT * FROM ${table};
          DROP TABLE ${table}; ALTER TABLE ${table}_v5 RENAME TO ${table};`);
      }
      raw.pragma('user_version = 5');
    }).immediate();
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    expect(() => raw.prepare('UPDATE club_settings SET court_count = 7').run()).toThrow('CHECK');
    expect(() => raw.prepare("INSERT INTO courts VALUES (7, 'available', NULL)").run()).toThrow('CHECK');
  } finally { raw.close(); }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  repositories.splice(0).forEach((value) => value.close());
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true }));
  vi.restoreAllMocks();
});

describe('one to sixteen court capacity', () => {
  it.each([10, 12, 15, 16])('configures and fills %i courts and completes a match on the highest court', async (count) => {
    const { app, value } = await open();
    const configured = await post(app, '/api/settings', { ...value.getSettings(), courtCount: count, courtNames: names(count) });
    expect(configured.statusCode).toBe(200);
    expect(configured.json<AppSnapshot>().courts.map((court) => court.name)).toEqual(names(count));
    const queue = add(value, count * 4 + 4);
    const reviewed = await post(app, '/api/rotation-plans');
    expect(reviewed.statusCode).toBe(201);
    const plan = reviewed.json<RotationPlan>();
    expect(plan.assignments.map((assignment) => assignment.courtId))
      .toEqual(Array.from({ length: count }, (_, index) => index + 1));
    const assignedIds = plan.assignments.flatMap((assignment) => assignment.players.map((player) => player.id));
    expect(new Set(assignedIds)).toEqual(new Set(queue.slice(0, count * 4)));
    expect(assignedIds).toHaveLength(count * 4);
    const applied = await post(app, `/api/rotation-plans/${plan.id}/apply`);
    expect(applied.statusCode).toBe(200);
    expect(applied.json<AppSnapshot>().courts.every((court) => court.players.length === 4)).toBe(true);
    expect(applied.json<AppSnapshot>().holdingPool.map((player) => player.id)).toEqual(queue.slice(count * 4));
    expect((await post(app, `/api/courts/${count}/start`)).statusCode).toBe(200);
    const ended = await post(app, `/api/courts/${count}/end`);
    expect(ended.statusCode).toBe(200);
    const snapshot = ended.json<AppSnapshot>();
    expect(snapshot.gameHistory[0]).toMatchObject({ courtId: count, courtName: names(count).at(-1), status: 'completed' });
    expect(new Set([...snapshot.holdingPool, ...snapshot.courts.flatMap((court) => court.players)]
      .map((player) => player.id))).toEqual(new Set(queue));
  });

  it('accepts court 16 for proposals, manual moves, staged assignments, toggles and voids', async () => {
    const { app, value } = await open();
    value.updateSettings({ ...value.getSettings(), courtCount: 16, courtNames: names(16) });
    const ids = add(value, 8);
    const proposal = value.persistProposal({ source: 'rules-fallback', playerIds: ids.slice(0, 4), notice: 'Queue first.' });
    expect((await post(app, `/api/match-proposals/${proposal.id}/apply`, { courtId: 16 })).statusCode).toBe(200);
    expect((await post(app, `/api/players/${ids[0]}/move`, { destination: { type: 'holding-pool' } })).statusCode).toBe(200);
    expect((await post(app, `/api/players/${ids[0]}/move`, { destination: { type: 'court', courtId: 16 } })).statusCode).toBe(200);
    expect((await post(app, '/api/courts/16/start')).statusCode).toBe(200);
    expect((await post(app, '/api/courts/16/void', { reason: 'Accidental match start' })).statusCode).toBe(200);
    expect(value.getSnapshot().gameHistory[0]).toMatchObject({ courtId: 16, status: 'voided' });
    expect((await post(app, '/api/courts/16/toggle')).statusCode).toBe(200);
    expect((await post(app, '/api/courts/16/toggle')).statusCode).toBe(200);
    ids.slice(4).forEach((id) => value.movePlayer(id, { type: 'next-game-pool', lane: 'intermediate' }));
    const staged = await post(app, '/api/courts/16/assign-staged', {
      sessionId: value.getSnapshot().session.id, lane: 'intermediate', playerIds: ids.slice(4),
    });
    expect(staged.statusCode).toBe(200);
    expect(staged.json<AppSnapshot>().courts[15]!.players.map((player) => player.id)).toEqual(ids.slice(4));
  });

  it('rejects court 17, excess names and mismatched names without changing the board', async () => {
    const { app, value } = await open();
    value.updateSettings({ ...value.getSettings(), courtCount: 16, courtNames: names(16) });
    const ids = add(value, 4);
    const proposal = value.persistProposal({ source: 'rules-fallback', playerIds: ids, notice: 'Queue first.' });
    const before = value.getSnapshot();
    for (const input of [
      { courtCount: 17, courtNames: names(17) }, { courtCount: 16, courtNames: names(17) },
      { courtCount: 16, courtNames: names(15) },
    ]) expect((await post(app, '/api/settings', { ...before.settings, ...input })).statusCode).toBe(400);
    for (const action of ['start', 'end', 'void', 'toggle', 'assign-staged']) {
      expect((await post(app, `/api/courts/17/${action}`)).statusCode).toBe(400);
    }
    expect((await post(app, `/api/match-proposals/${proposal.id}/apply`, { courtId: 17 })).statusCode).toBe(400);
    expect((await post(app, `/api/players/${ids[0]}/move`, { destination: { type: 'court', courtId: 17 } })).statusCode).toBe(400);
    expect(() => value.updateSettings({ ...before.settings, courtCount: 17, courtNames: names(17) })).toThrow('Invalid club settings');
    expect(value.getSnapshot()).toEqual(before);
  });

  it('protects occupied and playing high courts and invalidates a plan when court 16 is removed', async () => {
    const { app, value } = await open();
    value.updateSettings({ ...value.getSettings(), courtCount: 16, courtNames: names(16) });
    const ids = add(value, 8);
    ids.slice(0, 4).forEach((id) => value.movePlayer(id, { type: 'court', courtId: 16 }));
    const reduce = () => post(app, '/api/settings', { ...value.getSettings(), courtCount: 15, courtNames: names(15) });
    expect((await reduce()).statusCode).toBe(409);
    expect(value.getSnapshot().settings.courtCount).toBe(16);
    value.startGame(16);
    expect((await reduce()).statusCode).toBe(409);
    expect(value.getSnapshot().courts[15]!.status).toBe('in-play');
    value.endGame(16);
    const plan = value.createRotationPlan();
    expect((await reduce()).statusCode).toBe(200);
    const beforeApply = value.getSnapshot();
    expect((await post(app, `/api/rotation-plans/${plan.id}/apply`)).statusCode).toBe(409);
    expect(value.getSnapshot()).toEqual(beforeApply);
    expect((await post(app, '/api/courts/16/toggle')).statusCode).toBe(404);
  });

  it('migrates genuine v5 constraints without changing active games, history, rosters, settings or saved reviews', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const location = file(), original = repository(location);
    original.updateSettings({ ...original.getSettings(), venueName: 'Existing club', courtNames: names(6),
      timezone: 'Australia/Perth', rosterMapping: { name: 'Full name' }, avoidRepeatPartners: false });
    const ids = add(original, 16);
    ids.slice(0, 4).forEach((id) => original.movePlayer(id, { type: 'court', courtId: 1 }));
    original.startGame(1); original.endGame(1);
    ids.slice(0, 4).forEach((id) => original.movePlayer(id, { type: 'court', courtId: 6 }));
    original.startGame(6); original.toggleCourtStatus(5);
    original.movePlayer(ids[4]!, { type: 'next-game-pool', lane: 'intermediate' });
    original.setAttendance(ids[5]!, 'resting');
    const context = original.getMatchContext();
    original.persistProposal({ source: 'rules-fallback', playerIds: context.candidates.map((player) => player.id),
      contextRevision: context.revision, notice: 'Saved review before migration.' });
    const plan = original.createRotationPlan();
    const before = original.getSnapshot(), audit = original.getAuditEntriesForTests();
    original.close();
    downgradeToV5(location);
    const legacy = new Database(location, { readonly: true });
    const tables = ['players', 'courts', 'club_settings', 'game_history', 'match_proposals', 'rotation_plans', 'sessions', 'session_players', 'audit_log'];
    const rows = new Map(tables.map((table) => [table, legacy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    legacy.close();
    const migrated = repository(location);
    expect(migrated.getSchemaVersion()).toBe(6);
    expect(migrated.getSnapshot()).toEqual(before);
    expect(migrated.getCurrentRotationPlan()).toEqual(plan);
    expect(migrated.getAuditEntriesForTests()).toEqual(audit);
    const raw = new Database(location);
    try {
      expect(raw.pragma('foreign_key_check')).toEqual([]);
      for (const table of tables) expect(raw.prepare(`SELECT * FROM ${table}${table === 'courts' ? ' WHERE id <= 6' : ''} ORDER BY rowid`).all()).toEqual(rows.get(table));
      expect(raw.prepare('SELECT COUNT(*) FROM courts').pluck().get()).toBe(16);
      expect(() => raw.prepare("INSERT INTO courts VALUES (17, 'available', NULL)").run()).toThrow('CHECK');
      expect(() => raw.prepare('UPDATE club_settings SET court_count = 17').run()).toThrow('CHECK');
      expect(() => raw.prepare("INSERT INTO players SELECT 'invalid-court',name,skill_level,skill_rating,play_style,'court',NULL,0,17,created_at,attendance,source,external_id,waiting_since FROM players LIMIT 1").run()).toThrow('FOREIGN KEY');
    } finally { raw.close(); }
    migrated.endGame(6);
    expect(migrated.updateSettings({ ...migrated.getSettings(), courtCount: 16, courtNames: names(16) }).courts).toHaveLength(16);
    migrated.close();
    expect(repository(location).getSnapshot().courts).toHaveLength(16);
  });

  it('rolls the migration back when existing foreign-key damage is detected', () => {
    const location = file(), original = repository(location);
    add(original, 1);
    original.close();
    downgradeToV5(location);
    const damaged = new Database(location);
    try {
      damaged.pragma('foreign_keys = OFF');
      damaged.prepare("UPDATE players SET location_type = 'court', court_id = 99, next_lane = NULL").run();
    } finally { damaged.close(); }
    expect(() => new Repository(location)).toThrow('foreign-key validation');
    const preserved = new Database(location);
    try {
      expect(preserved.pragma('user_version', { simple: true })).toBe(5);
      expect(preserved.prepare('SELECT court_id FROM players').pluck().get()).toBe(99);
      expect(preserved.prepare('SELECT COUNT(*) FROM courts').pluck().get()).toBe(6);
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE name IN ('courts_v6', 'club_settings_v6')").all()).toEqual([]);
      expect(() => preserved.prepare('UPDATE club_settings SET court_count = 7').run()).toThrow('CHECK');
    } finally { preserved.close(); }
  });
});
