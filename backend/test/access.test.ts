import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import type { AppSnapshot, SessionReport } from '../src/models.js';

const KEY = 'private-operator-test-key-only';
const apps: FastifyInstance[] = [];
const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  host: '127.0.0.1', port: 3000, operatorAccessKey: KEY, corsOrigins: ['http://localhost:5173'],
  databasePath: ':memory:', bodyLimit: 65_536, rateLimitMax: 1000, rateLimitWindow: '1 minute', demoSeed: false, publicDemo: true, ...overrides,
});
const headers = (accessKey: string) => ({ authorization: `Bearer ${accessKey}` });
async function makeApp(overrides: Partial<AppConfig> = {}) {
  const repository = new Repository(':memory:');
  const app = await buildApp({ config: config(overrides), repository });
  apps.push(app);
  return { app, repository };
}
async function visitor(app: FastifyInstance, address = '127.0.0.1') {
  const response = await app.inject({ method: 'POST', url: '/api/visitor-sessions', remoteAddress: address });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessKey: string; expiresAt: number }>();
}
const state = async (app: FastifyInstance, key: string) => (
  await app.inject({ method: 'GET', url: '/api/state', headers: headers(key) })
).json<AppSnapshot>();

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('isolated visitor and court display access', () => {
  it('starts the public edition with a populated twelve-court fictional club session', async () => {
    const { app, repository } = await makeApp();
    const own = await visitor(app);
    const snapshot = await state(app, own.accessKey);
    expect(snapshot.settings).toMatchObject({ venueName: 'Sidecourt', courtCount: 12,
      courtNames: Array.from({ length: 12 }, (_, index) => `Court ${index + 1}`) });
    expect(snapshot.courts).toHaveLength(12);
    expect(snapshot.courts.slice(0, 8).every((court) => court.status === 'in-play'
      && court.players.length === 4 && court.gameStartedAt !== null && court.timeElapsed > 0)).toBe(true);
    expect(snapshot.courts.slice(8, 10).every((court) => court.status === 'available'
      && court.players.length === 4 && court.gameStartedAt === null && court.timeElapsed === 0)).toBe(true);
    expect(snapshot.courts.slice(10).every((court) => court.status === 'available'
      && court.players.length === 0)).toBe(true);
    expect(snapshot.roster).toHaveLength(96);
    expect(snapshot.holdingPool).toHaveLength(32);
    expect(snapshot.nextGamePool.intermediate).toHaveLength(4);
    expect(Object.values(snapshot.nextGamePool).flat()).toHaveLength(4);
    expect(snapshot.gameHistory).toHaveLength(37);
    expect(snapshot.sessions.filter((session) => session.endedAt !== null)).toHaveLength(2);
    const report = await app.inject({ method: 'GET', url: `/api/sessions/${snapshot.session.id}/report`, headers: headers(own.accessKey) });
    expect(report.json<SessionReport>().totals).toMatchObject({ registeredPlayers: 96, checkedInPlayers: 88,
      completedMatches: 36, voidedMatches: 1, correctedMatches: 1, unattributedCompletedMatches: 0 });
    expect(report.json<SessionReport>().totals.completedCourtSeconds).toBeGreaterThan(0);
    expect(report.json<SessionReport>().activeMatches).toBe(8);
    expect(repository.getSnapshot().settings.courtCount).toBe(6);
    expect(repository.getSnapshot().roster).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/courts/9/start', headers: headers(own.accessKey) })).statusCode).toBe(200);
    expect((await state(app, own.accessKey)).courts[8]!.status).toBe('in-play');
  });

  it('never seeds or mutates the private repository and isolates simultaneous visitors', async () => {
    const { app, repository } = await makeApp({ demoSeed: true });
    const first = await visitor(app);
    const second = await visitor(app);
    expect(first.accessKey).not.toBe(second.accessKey);
    const before = await state(app, second.accessKey);
    const own = await state(app, first.accessKey);
    expect(own.roster).toHaveLength(96);
    expect(own.roster.some((player) => before.roster.some((other) => other.id === player.id))).toBe(false);
    const changed = await app.inject({ method: 'POST', url: '/api/players', headers: headers(first.accessKey), payload: {
      name: 'Visitor One Only', skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced',
    } });
    expect(changed.statusCode).toBe(201);
    expect(await state(app, second.accessKey)).toEqual(before);
    expect(repository.getSnapshot().roster).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/api/state', headers: headers(KEY) })).statusCode).toBe(401);
  });

  it('resets only the authenticated visitor and revokes their previous display grants', async () => {
    const { app } = await makeApp();
    const first = await visitor(app);
    const second = await visitor(app);
    const otherBefore = await state(app, second.accessKey);
    const ownBefore = await state(app, first.accessKey);
    const grant = await app.inject({ method: 'POST', url: '/api/display-access', headers: headers(first.accessKey) });
    const displayKey = grant.json<{ accessKey: string }>().accessKey;
    const reset = await app.inject({ method: 'POST', url: '/api/visitor-reset', headers: headers(first.accessKey) });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<AppSnapshot>().settings.courtCount).toBe(12);
    expect(reset.json<AppSnapshot>().courts[0]!.players).toHaveLength(4);
    expect(reset.json<AppSnapshot>().gameHistory).toHaveLength(37);
    expect(reset.json<AppSnapshot>().sessions.filter((session) => session.endedAt !== null)).toHaveLength(2);
    expect(reset.json<AppSnapshot>().roster.map((player) => player.id)).not.toEqual(ownBefore.roster.map((player) => player.id));
    expect(await state(app, second.accessKey)).toEqual(otherBefore);
    expect((await app.inject({ method: 'GET', url: '/api/display', headers: headers(displayKey) })).statusCode).toBe(401);
  });

  it('provides a strictly scoped, redacted player display without permitting writes or operator state', async () => {
    const { app } = await makeApp();
    const own = await visitor(app);
    const grant = await app.inject({ method: 'POST', url: '/api/display-access', headers: headers(own.accessKey) });
    expect(grant.statusCode).toBe(201);
    const display = grant.json<{ accessKey: string; expiresAt: number }>();
    expect(display.expiresAt).toBeLessThanOrEqual(own.expiresAt);
    const response = await app.inject({ method: 'GET', url: '/api/display', headers: headers(display.accessKey) });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(['courts', 'holdingPool', 'nextGamePool', 'session', 'settings']);
    const serialized = response.body;
    for (const secret of ['externalId', 'skillRating', 'skillLevel', 'playStyle', 'createdAt', 'roster']) {
      expect(serialized).not.toContain(`"${secret}"`);
    }
    expect(Object.keys(response.json().courts[0].players[0]).sort()).toEqual(['id', 'name']);
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/api/state', headers: headers(display.accessKey) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/courts/1/start', headers: headers(display.accessKey) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/display', headers: headers(own.accessKey) })).statusCode).toBe(401);
  });

  it('caps display grants and visitor capacity; expired grants release capacity without resetting a client database', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { app, repository } = await makeApp({ maxVisitors: 1, visitorTtlMs: 1000 });
    const own = await visitor(app);
    const displayKeys: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const grant = await app.inject({ method: 'POST', url: '/api/display-access', headers: headers(own.accessKey) });
      displayKeys.push(grant.json<{ accessKey: string }>().accessKey);
    }
    expect((await app.inject({ method: 'GET', url: '/api/display', headers: headers(displayKeys[0]!) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/display', headers: headers(displayKeys[5]!) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/visitor-sessions' })).statusCode).toBe(503);
    now += 1001;
    expect((await app.inject({ method: 'GET', url: '/api/state', headers: headers(own.accessKey) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/display', headers: headers(displayKeys[5]!) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/visitor-sessions' })).statusCode).toBe(201);
    expect(repository.ping()).toBe(true);
  });

  it('does not extend visitor lifetime by resetting a board', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { app } = await makeApp({ visitorTtlMs: 1000 });
    const own = await visitor(app);
    now += 500;
    expect((await app.inject({ method: 'POST', url: '/api/visitor-reset', headers: headers(own.accessKey) })).statusCode).toBe(200);
    now += 501;
    expect((await app.inject({ method: 'GET', url: '/api/state', headers: headers(own.accessKey) })).statusCode).toBe(401);
  });

  it('keeps private operator access intact and rejects reset and visitor creation', async () => {
    const { app } = await makeApp({ publicDemo: false });
    expect((await app.inject({ method: 'GET', url: '/api/state', headers: headers(KEY) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/visitor-reset', headers: headers(KEY) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/visitor-sessions', headers: headers(KEY) })).statusCode).toBe(404);
  });

  it('rate limits unauthenticated visitor creation and does not trust arbitrary extra forwarded hops', async () => {
    const { app } = await makeApp({ maxVisitors: 20, trustProxyHops: 1 });
    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/visitor-sessions',
        headers: { 'x-forwarded-for': `192.0.2.${index}, 198.51.100.8` } });
      expect(response.statusCode).toBe(201);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/visitor-sessions',
      headers: { 'x-forwarded-for': '192.0.2.200, 198.51.100.8' } });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['cache-control']).toBe('no-store');
  });

  it('bounds a public roster without blocking repeated imports or changing the board on overflow', async () => {
    const { app } = await makeApp();
    const own = await visitor(app);
    const row = (index: number) => ({ externalId: `club-${index}`, name: `Club player ${index}`,
      skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced' });
    const importedRows = Array.from({ length: 500 - (await state(app, own.accessKey)).roster.length }, (_, index) => row(index));
    const importRows = (rows: ReturnType<typeof row>[]) => app.inject({ method: 'POST', url: '/api/roster/import',
      headers: headers(own.accessKey), payload: { source: 'club-roster', rows } });
    for (let index = 0; index < importedRows.length; index += 200) {
      expect((await importRows(importedRows.slice(index, index + 200))).statusCode).toBe(200);
    }
    const before = await state(app, own.accessKey);
    expect(before.roster).toHaveLength(500);
    expect((await importRows(importedRows.slice(0, 200))).statusCode).toBe(200);
    const oversized = await importRows([row(501)]);
    expect(oversized.statusCode).toBe(409);
    expect(oversized.json().error.code).toBe('ROSTER_LIMIT');
    const direct = await app.inject({ method: 'POST', url: '/api/players', headers: headers(own.accessKey), payload: {
      name: 'Must not be added', skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced',
    } });
    expect(direct.statusCode).toBe(409);
    expect(await state(app, own.accessKey)).toEqual(before);
  });

  it('exposes settings, dated session closeout and authenticated CSV through validated routes', async () => {
    const { app } = await makeApp();
    const own = await visitor(app);
    const initial = await state(app, own.accessKey);
    for (const court of initial.courts.filter((item) => item.status === 'in-play')) {
      expect((await app.inject({ method: 'POST', url: `/api/courts/${court.id}/end`,
        headers: headers(own.accessKey) })).statusCode).toBe(200);
    }
    for (const court of (await state(app, own.accessKey)).courts.filter((item) => item.id > 2)) {
      for (const player of court.players) {
        expect((await app.inject({ method: 'POST', url: `/api/players/${player.id}/move`,
          headers: headers(own.accessKey), payload: { destination: { type: 'holding-pool' } } })).statusCode).toBe(200);
      }
    }
    const settings = { venueName: 'Northern Courts', courtCount: 2, timezone: 'Australia/Perth', gameMode: 'doubles' };
    const changed = await app.inject({ method: 'POST', url: '/api/settings', headers: headers(own.accessKey), payload: settings });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<AppSnapshot>().courts).toHaveLength(2);
    const invalid = await app.inject({ method: 'POST', url: '/api/settings', headers: headers(own.accessKey), payload: { ...settings, timezone: 'Australia/NotAPlace' } });
    expect(invalid.statusCode).toBe(400);
    const closed = await app.inject({ method: 'POST', url: '/api/sessions/close', headers: headers(own.accessKey) });
    expect(closed.statusCode).toBe(200);
    const sessionId = closed.json<AppSnapshot>().session.id;
    const started = await app.inject({ method: 'POST', url: '/api/sessions', headers: headers(own.accessKey), payload: { name: 'Tuesday social' } });
    expect(started.statusCode).toBe(201);
    expect(started.json<AppSnapshot>().session.name).toBe('Tuesday social');
    for (const kind of ['attendance', 'matches']) {
      const exported = await app.inject({ method: 'GET', url: `/api/sessions/export?kind=${kind}&sessionId=${sessionId}`, headers: headers(own.accessKey) });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-type']).toContain('text/csv');
      expect(exported.headers['content-disposition']).toContain(`session-${kind}.csv`);
      expect(exported.headers['cache-control']).toBe('no-store');
    }
    expect((await app.inject({ method: 'GET', url: '/api/sessions/export?kind=secrets', headers: headers(own.accessKey) })).statusCode).toBe(400);
  });
});

describe('deployment configuration', () => {
  it('requires a private operator secret but permits isolated public operation without one', () => {
    expect(() => loadConfig({})).toThrow('OPERATOR_ACCESS_KEY');
    expect(loadConfig({ PUBLIC_DEMO: 'true' }).publicDemo).toBe(true);
    expect(loadConfig({ PUBLIC_DEMO: 'true' }).operatorAccessKey).toBe('');
    expect(loadConfig({ OPERATOR_ACCESS_KEY: KEY }).trustProxyHops).toBe(1);
  });

  it('validates capacity, lifetime and exact browser origins', () => {
    for (const invalid of [
      { VISITOR_TTL_MINUTES: '0' }, { MAX_VISITORS: '100000' }, { TRUST_PROXY_HOPS: '99' },
      { CORS_ORIGINS: '*' }, { CORS_ORIGINS: 'https://club.example/path' },
    ]) expect(() => loadConfig({ PUBLIC_DEMO: 'true', ...invalid })).toThrow('Invalid server configuration');
    expect(loadConfig({ PUBLIC_DEMO: 'true', CORS_ORIGINS: 'https://club.example,http://localhost:5173' }).corsOrigins)
      .toEqual(['https://club.example', 'http://localhost:5173']);
  });
});
