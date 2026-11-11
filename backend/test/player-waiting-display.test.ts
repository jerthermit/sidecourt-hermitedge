import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import type { AppSnapshot } from '../src/models.js';

const key = 'fictional-operator-waiting-display-key';
const apps: FastifyInstance[] = [];
const authorization = (accessKey: string) => ({ authorization: `Bearer ${accessKey}` });
type Display = {
  courts: Array<{ players: Array<{ id: string; name: string }> }>;
  nextGamePool: Record<string, Array<{ id: string; name: string }>>;
  holdingPool: Array<{ id: string; name: string }>;
};
const identities = (players: AppSnapshot['holdingPool']) => players.map(({ id, name }) => ({ id, name }));

async function setup(publicDemo = false) {
  const repository = new Repository(':memory:');
  if (!publicDemo) repository.seedPublicFixture();
  const config: AppConfig = { host: '127.0.0.1', port: 3000, operatorAccessKey: key,
    corsOrigins: ['http://localhost:5173'], databasePath: ':memory:', bodyLimit: 65_536,
    rateLimitMax: 1000, rateLimitWindow: '1 minute', demoSeed: false, publicDemo };
  const app = await buildApp({ config, repository });
  apps.push(app);
  return { app, repository };
}
async function displayKey(app: FastifyInstance, operatorKey = key) {
  const grant = await app.inject({ method: 'POST', url: '/api/display-access', headers: authorization(operatorKey) });
  expect(grant.statusCode).toBe(201);
  return grant.json<{ accessKey: string }>().accessKey;
}
const readDisplay = (app: FastifyInstance, accessKey: string) => app.inject({
  method: 'GET', url: '/api/display', headers: authorization(accessKey),
});

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000); });
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe('read-only waiting display projection', () => {
  it('returns all 32 waiting identities in authoritative order across the twelve-court, 96-player fixture', async () => {
    const { app, repository } = await setup();
    const accessKey = await displayKey(app);
    const before = repository.getSnapshot();
    const audit = repository.getAuditEntriesForTests();
    const response = await readDisplay(app, accessKey);
    expect(response.statusCode).toBe(200);
    const display = response.json<Display>();
    expect(before.roster).toHaveLength(96);
    expect(display.courts).toHaveLength(12);
    expect(display.holdingPool).toHaveLength(32);
    expect(display.holdingPool).toEqual(identities(before.holdingPool));
    const elsewhere = new Set([
      ...before.courts.flatMap((court) => court.players), ...Object.values(before.nextGamePool).flat(),
      ...before.roster.filter((player) => player.attendance !== 'ready'),
    ].map((player) => player.id));
    expect(display.holdingPool.every((player) => !elsewhere.has(player.id))).toBe(true);
    const allVisible = [...display.holdingPool, ...display.courts.flatMap((court) => court.players),
      ...Object.values(display.nextGamePool).flat()];
    expect(allVisible).toHaveLength(76);
    for (const player of allVisible) expect(Object.keys(player).sort()).toEqual(['id', 'name']);
    expect(Object.keys(display).sort()).toEqual(['courts', 'holdingPool', 'nextGamePool', 'session', 'settings']);
    for (const privateField of ['externalId', 'source', 'skillRating', 'skillLevel', 'playStyle', 'attendance',
      'createdAt', 'waitingSince', 'gamesPlayed', 'playedSeconds', 'roster', 'participants', 'gameHistory', 'accessKey']) {
      expect(response.body).not.toContain(`"${privateField}"`);
    }
    for (const player of before.roster) {
      if (player.externalId) expect(response.body).not.toContain(player.externalId);
    }
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(audit);
  });

  it('reflects reordering and excludes staged, assigned, resting, expected and departed players on later polls', async () => {
    const { app, repository } = await setup();
    const accessKey = await displayKey(app);
    const initial = repository.getSnapshot();
    const waiting = initial.holdingPool;
    repository.reorderHoldingPool(waiting[31]!.id, 0);
    repository.movePlayer(waiting[0]!.id, { type: 'next-game-pool', lane: 'mixed' });
    repository.movePlayer(waiting[1]!.id, { type: 'court', courtId: 11 });
    repository.setAttendance(waiting[2]!.id, 'resting');
    repository.setAttendance(waiting[3]!.id, 'expected');
    repository.setAttendance(waiting[4]!.id, 'departed');
    const confirmed = repository.getSnapshot();
    const display = (await readDisplay(app, accessKey)).json<Display>();
    expect(display.holdingPool).toEqual(identities(confirmed.holdingPool));
    expect(display.holdingPool).toHaveLength(27);
    expect(display.holdingPool[0]).toEqual(identities([waiting[31]!])[0]);
    expect(display.holdingPool.some((player) => waiting.slice(0, 5).some((excluded) => excluded.id === player.id))).toBe(false);
    expect(display.nextGamePool.mixed).toContainEqual(identities([waiting[0]!])[0]);
    expect(display.courts[10]!.players).toContainEqual(identities([waiting[1]!])[0]);
  });

  it('returns an empty queue and keeps every operator read and mutation denied to a display key', async () => {
    const { app, repository } = await setup();
    const accessKey = await displayKey(app);
    const initial = repository.getSnapshot();
    for (const player of initial.holdingPool) repository.setAttendance(player.id, 'resting');
    const before = repository.getSnapshot();
    expect((await readDisplay(app, accessKey)).json<Display>().holdingPool).toEqual([]);
    const attempts = [
      { method: 'GET' as const, url: '/api/state' },
      { method: 'GET' as const, url: `/api/sessions/${before.session.id}/report` },
      { method: 'POST' as const, url: '/api/holding/reorder', payload: { playerId: initial.holdingPool[0]!.id, targetIndex: 1 } },
      { method: 'POST' as const, url: `/api/players/${initial.holdingPool[0]!.id}/attendance`, payload: { attendance: 'ready' } },
      { method: 'POST' as const, url: '/api/courts/9/start' },
    ];
    for (const attempt of attempts) {
      expect((await app.inject({ ...attempt, headers: authorization(accessKey) })).statusCode).toBe(401);
    }
    expect(repository.getSnapshot()).toEqual(before);
  });

  it('keeps visitor waiting identities isolated and refuses operator credentials on the player endpoint', async () => {
    const { app } = await setup(true);
    const visitors: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/visitor-sessions' });
      visitors.push(response.json<{ accessKey: string }>().accessKey);
    }
    const first = (await readDisplay(app, await displayKey(app, visitors[0]!))).json<Display>();
    const second = (await readDisplay(app, await displayKey(app, visitors[1]!))).json<Display>();
    expect(first.holdingPool).toHaveLength(32);
    expect(second.holdingPool).toHaveLength(32);
    expect(first.holdingPool.map((player) => player.name)).toEqual(second.holdingPool.map((player) => player.name));
    expect(first.holdingPool.some((player) => second.holdingPool.some((other) => other.id === player.id))).toBe(false);
    expect((await readDisplay(app, visitors[0]!)).statusCode).toBe(401);
    expect((await readDisplay(app, key)).statusCode).toBe(401);
  });
});
