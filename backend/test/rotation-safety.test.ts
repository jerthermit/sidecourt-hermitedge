import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { FastifyInstance } from 'fastify';
import type { AppSnapshot, RotationPlan } from '../src/models.js';

const repos: Repository[] = [], dirs: string[] = [], apps: FastifyInstance[] = [];
function file() { const dir = fs.mkdtempSync(path.join(tmpdir(), 'sidecourt-rotation-safety-')); dirs.push(dir); return path.join(dir, 'board.db'); }
function repo(location = ':memory:') { const value = new Repository(location); repos.push(value); return value; }
function prepare(value: Repository, count = 8) {
  value.updateSettings({ ...value.getSettings(), courtCount: 2, courtNames: ['North', 'South'] });
  for (let index = 0; index < count; index++) value.createPlayer({ name: `Player ${index}`, skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced' });
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  repos.splice(0).forEach(value => value.close());
  dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true }));
  vi.restoreAllMocks();
});

describe('rotation transaction and access boundaries', () => {
  it('allows an expired review to be closed without reviving it or changing the board', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const value = repo(); prepare(value);
    const plan = value.createRotationPlan(), before = value.getSnapshot();
    clock.mockReturnValue(plan.expiresAt + 1);
    expect(value.rejectRotationPlan(plan.id)).toEqual({ id: plan.id, status: 'expired' });
    expect(value.getCurrentRotationPlan()).toBeNull();
    expect(value.getSnapshot()).toEqual(before);
    expect(value.getAuditEntriesForTests().some(entry => entry.action === 'rotation_plan.rejected')).toBe(false);
  });

  it.each(['singles', 'doubles'] as const)('excludes staged and absent players, partial, disabled and playing courts in %s', (gameMode) => {
    const value = repo(); prepare(value, 24);
    value.updateSettings({ ...value.getSettings(), courtCount: 6, gameMode,
      courtNames: ['North', 'South', 'East', 'West', 'River', 'Park'] });
    const ids = value.getSnapshot().holdingPool.map(player => player.id), size = gameMode === 'singles' ? 2 : 4;
    value.movePlayer(ids[0]!, { type: 'court', courtId: 1 });
    value.movePlayer(ids[1]!, { type: 'next-game-pool', lane: 'mixed' });
    value.setAttendance(ids[2]!, 'resting'); value.setAttendance(ids[3]!, 'expected'); value.setAttendance(ids[4]!, 'departed');
    value.toggleCourtStatus(2);
    ids.slice(5, 5 + size).forEach(id => value.movePlayer(id, { type: 'court', courtId: 3 })); value.startGame(3);
    const before = value.getSnapshot(), plan = value.createRotationPlan();
    expect(plan.assignments.map(assignment => assignment.courtId)).toEqual([4, 5, 6]);
    expect(plan.assignments.every(assignment => assignment.players.length === size && !assignment.mixed)).toBe(true);
    expect(new Set(plan.assignments.flatMap(assignment => assignment.players.map(player => player.id))))
      .toEqual(new Set(before.holdingPool.slice(0, size * 3).map(player => player.id)));
    value.applyRotationPlan(plan.id);
    const after = value.getSnapshot();
    expect(after.courts.slice(0, 3).map(court => ({ status: court.status, players: court.players })))
      .toEqual(before.courts.slice(0, 3).map(court => ({ status: court.status, players: court.players })));
    expect(after.nextGamePool).toEqual(before.nextGamePool);
  });

  it('applies valid strict-band courts while leaving the blocked oldest remainder waiting', () => {
    const value = repo();
    value.updateSettings({ ...value.getSettings(), courtCount: 2, courtNames: ['North', 'South'], rotationMode: 'skill-banded' });
    for (const [band, count, rating] of [['beginner', 4, 2], ['intermediate', 1, 3.5], ['advanced', 4, 4.5]] as const)
      for (let index = 0; index < count; index++) value.createPlayer({ name: `${band} ${index}`, skillLevel: band, skillRating: rating, playStyle: 'Balanced' });
    const plan = value.createRotationPlan();
    expect(plan.assignments).toHaveLength(1); expect(plan.blockedReason).toContain('intermediate');
    expect(plan.canMix).toBe(true); expect(plan.waiting).toHaveLength(5);
    value.applyRotationPlan(plan.id);
    expect(value.getSnapshot().courts.map(court => court.players.length)).toEqual([4, 0]);
    expect(value.getSnapshot().holdingPool.map(player => player.id)).toEqual(plan.waiting.map(player => player.id));
  });

  it('upgrades schema v4 without changing active play, historical records or saved proposals', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const location = file(), original = repo(location); prepare(original);
    const ids = original.getSnapshot().holdingPool.map(player => player.id);
    ids.slice(0, 4).forEach(id => original.movePlayer(id, { type: 'court', courtId: 1 }));
    original.startGame(1); original.endGame(1);
    ids.slice(0, 4).forEach(id => original.movePlayer(id, { type: 'court', courtId: 2 })); original.startGame(2);
    const context = original.getMatchContext();
    original.persistProposal({ source: 'ai', playerIds: context.candidates.map(player => player.id), contextRevision: context.revision, notice: 'Historical saved pairing.' });
    const before = original.getSnapshot(), audit = original.getAuditEntriesForTests();
    original.close(); repos.splice(repos.indexOf(original), 1);
    const raw = new Database(location);
    try { raw.exec('DROP TABLE rotation_plans; PRAGMA user_version = 4;'); } finally { raw.close(); }
    const migrated = repo(location);
    expect(migrated.getSchemaVersion()).toBe(6); expect(migrated.getSnapshot()).toEqual(before);
    expect(migrated.getAuditEntriesForTests()).toEqual(audit);
  });

  it('rolls every court move and audit back when a later court update fails', () => {
    const location = file(), value = repo(location); prepare(value);
    const plan = value.createRotationPlan(), before = value.getSnapshot(), audit = value.getAuditEntriesForTests();
    const raw = new Database(location);
    try { raw.exec(`CREATE TRIGGER fail_second_court BEFORE UPDATE OF court_id ON players
      WHEN NEW.court_id = 2 BEGIN SELECT RAISE(ABORT, 'forced test failure'); END;`); }
    finally { raw.close(); }
    expect(() => value.applyRotationPlan(plan.id)).toThrow('forced test failure');
    expect(value.getSnapshot()).toEqual(before);
    expect(value.getAuditEntriesForTests()).toEqual(audit);
    expect(value.getCurrentRotationPlan()?.id).toBe(plan.id);
  });

  it('serializes two connections and makes an unchanged duplicate apply audit-neutral', () => {
    const location = file(), first = repo(location); prepare(first);
    const second = repo(location), plan = first.createRotationPlan();
    second.applyRotationPlan(plan.id);
    const committed = first.getSnapshot(), audit = first.getAuditEntriesForTests();
    first.applyRotationPlan(plan.id);
    expect(first.getSnapshot()).toEqual(committed);
    expect(first.getAuditEntriesForTests()).toEqual(audit);
    expect(audit.filter(entry => entry.action === 'rotation_plan.applied')).toHaveLength(1);
    first.startGame(1);
    expect(() => second.applyRotationPlan(plan.id)).toThrow('already applied');
  });

  it('rejects expired approval without moving players or creating an apply record', () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const value = repo(); prepare(value); const plan = value.createRotationPlan();
    const before = value.getSnapshot(); now = plan.expiresAt;
    expect(() => value.applyRotationPlan(plan.id)).toThrow('expired');
    expect(value.getSnapshot()).toEqual(before);
    expect(value.getAuditEntriesForTests().some(entry => entry.action === 'rotation_plan.applied')).toBe(false);
    expect(value.getCurrentRotationPlan()).toBeNull();
  });

  it('bounds stored reviews while retaining only one pending plan', () => {
    const location = file(), value = repo(location);
    for (let index = 0; index < 130; index++) value.createRotationPlan();
    const raw = new Database(location, { readonly: true });
    try {
      expect(raw.prepare('SELECT count(*) FROM rotation_plans').pluck().get()).toBeLessThanOrEqual(100);
      expect(raw.prepare("SELECT count(*) FROM rotation_plans WHERE status = 'pending'").pluck().get()).toBe(1);
    } finally { raw.close(); }
  });

  it('denies display credentials and keeps visitor plans isolated', async () => {
    const app = await buildApp({ config: loadConfig({ PUBLIC_DEMO: 'true' }) }); apps.push(app);
    const post = (url: string, key?: string, payload: unknown = {}) => app.inject({ method: 'POST', url,
      ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}), payload });
    const first = (await post('/api/visitor-sessions')).json<{ accessKey: string }>().accessKey;
    const second = (await post('/api/visitor-sessions')).json<{ accessKey: string }>().accessKey;
    const display = (await post('/api/display-access', first)).json<{ accessKey: string }>().accessKey;
    expect((await post('/api/rotation-plans')).statusCode).toBe(401);
    expect((await post('/api/rotation-plans', display)).statusCode).toBe(401);
    const review = await post('/api/rotation-plans', first); expect(review.statusCode).toBe(201);
    const plan = review.json<RotationPlan>();
    expect((await post(`/api/rotation-plans/${plan.id}/reject`)).statusCode).toBe(401);
    expect((await post(`/api/rotation-plans/${plan.id}/reject`, display)).statusCode).toBe(401);
    expect((await post(`/api/rotation-plans/${plan.id}/reject`, second)).statusCode).toBe(404);
    expect((await post(`/api/rotation-plans/${plan.id}/apply`, display)).statusCode).toBe(401);
    expect((await post(`/api/rotation-plans/${plan.id}/apply`, second)).statusCode).toBe(404);
    const applied = await post(`/api/rotation-plans/${plan.id}/apply`, first);
    expect(applied.statusCode).toBe(200);
    expect(applied.json<AppSnapshot>().courts.map(court => court.players.length)).toEqual(Array(12).fill(4));
    const untouched = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${second}` } });
    expect(untouched.json<AppSnapshot>().holdingPool).toHaveLength(32);
  });
});
