import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { AppSnapshot, MatchProposal } from '../src/models.js';

const key = 'integration-operator-not-a-production-secret';
const headers = { authorization: `Bearer ${key}` };
const apps: FastifyInstance[] = [];
const configuration: AppConfig = {
  host: '127.0.0.1', port: 3001, operatorAccessKey: key,
  corsOrigins: ['http://localhost:5173'], databasePath: ':memory:',
  bodyLimit: 65_536, rateLimitMax: 100_000, rateLimitWindow: '1 minute', demoSeed: false,
};

async function open(overrides: Partial<AppConfig> = {}) {
  const app = await buildApp({ config: { ...configuration, ...overrides } });
  apps.push(app);
  return app;
}

async function state(app: FastifyInstance, auth = headers): Promise<AppSnapshot> {
  const response = await app.inject({ method: 'GET', url: '/api/state', headers: auth });
  expect(response.statusCode).toBe(200);
  return response.json<AppSnapshot>();
}

async function post(app: FastifyInstance, url: string, payload?: unknown, auth = headers) {
  return app.inject({ method: 'POST', url, headers: auth, ...(payload === undefined ? {} : { payload }) });
}

async function add(app: FastifyInstance, name: string, rating: number) {
  const response = await post(app, '/api/players', {
    name, skillLevel: 'intermediate', skillRating: rating, playStyle: 'Balanced',
  });
  expect(response.statusCode).toBe(201);
  return response.json<AppSnapshot>().holdingPool.at(-1)!.id;
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('companion end-to-end invariants', () => {
  it.each([2, 6])('runs a %i-court club through FIFO rotation without duplicate players or records', async (courtCount) => {
    const app = await open();
    const settings = { ...(await state(app)).settings, courtCount,
      courtNames: Array.from({ length: courtCount }, (_, index) => `Court ${index + 1}`) };
    expect((await post(app, '/api/settings', settings)).statusCode).toBe(200);
    const ids: string[] = [];
    // Deliberately alternating ratings: fairness must beat selecting the closest-rated quartet.
    for (let index = 0; index < 24; index += 1) ids.push(await add(app, `Club player ${index + 1}`, index % 2 ? 5 : 2));
    for (let game = 0; game < 36; game += 1) {
      const before = await state(app);
      const expected = before.holdingPool.slice(0, 4).map((player) => player.id).sort();
      const proposed = await post(app, '/api/match-proposals');
      expect(proposed.statusCode).toBe(201);
      const proposal = proposed.json<MatchProposal>();
      expect([...proposal.playerIds].sort()).toEqual(expected);
      const courtId = game % courtCount + 1;
      const applied = await post(app, `/api/match-proposals/${proposal.id}/apply`, { courtId });
      expect(applied.statusCode).toBe(200);
      expect(applied.json<AppSnapshot>().courts.find((court) => court.id === courtId)!.players).toHaveLength(4);
      expect((await post(app, `/api/courts/${courtId}/start`)).statusCode).toBe(200);
      const finished = await post(app, `/api/courts/${courtId}/end`);
      expect(finished.statusCode).toBe(200);
      const snapshot = finished.json<AppSnapshot>();
      const located = [
        ...snapshot.holdingPool,
        ...Object.values(snapshot.nextGamePool).flat(),
        ...snapshot.courts.flatMap((court) => court.players),
      ];
      expect(located).toHaveLength(24);
      expect(new Set(located.map((player) => player.id)).size).toBe(24);
      expect(snapshot.gameHistory).toHaveLength(game + 1);
      expect(snapshot.courts).toHaveLength(courtCount);
    }
    const final = await state(app);
    // Team order may change within each FIFO quartet; membership/turn order must not.
    for (let index = 0; index < ids.length; index += 4) {
      expect(final.holdingPool.slice(index, index + 4).map((player) => player.id).sort())
        .toEqual(ids.slice(index, index + 4).sort());
    }
    expect(final.roster.every((player) => player.gamesPlayed === 6)).toBe(true);
    expect((await post(app, '/api/sessions/close')).statusCode).toBe(200);
    const exported = await app.inject({ method: 'GET', url: '/api/sessions/export?kind=matches', headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.body.trim().split(/\r?\n/)).toHaveLength(37);
  });

  it('commits competing approvals/start/end only once and protects stale queue selections', async () => {
    const app = await open();
    for (let index = 0; index < 8; index += 1) await add(app, `Concurrent player ${index + 1}`, 3.5);
    const proposal = (await post(app, '/api/match-proposals')).json<MatchProposal>();
    const attempts = await Promise.all([1, 2].map((courtId) =>
      post(app, `/api/match-proposals/${proposal.id}/apply`, { courtId })));
    expect(attempts.map((attempt) => attempt.statusCode).sort()).toEqual([200, 409]);
    const assigned = (await state(app)).courts.find((court) => court.players.length > 0)!;
    expect(assigned.players).toHaveLength(4);
    expect((await Promise.all([1, 2].map(() => post(app, `/api/courts/${assigned.id}/start`))))
      .map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect((await Promise.all([1, 2].map(() => post(app, `/api/courts/${assigned.id}/end`))))
      .map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect((await state(app)).gameHistory).toHaveLength(1);
    const stale = (await post(app, '/api/match-proposals')).json<MatchProposal>();
    const before = await state(app);
    const mover = before.holdingPool[4]!.id;
    expect((await post(app, `/api/players/${mover}/move`, { destination: { type: 'holding-pool', index: 0 } })).statusCode).toBe(200);
    expect((await post(app, `/api/match-proposals/${stale.id}/apply`, { courtId: 1 })).statusCode).toBe(409);
    expect((await state(app)).courts.every((court) => court.players.length === 0)).toBe(true);
  });

  it('archives identity safely, prevents closed-session edits and preserves roster between sessions', async () => {
    const app = await open();
    const ids: string[] = [];
    for (const name of ['=HYPERLINK("https://example.invalid")', 'Same name', 'Same name', 'Club fourth']) {
      ids.push(await add(app, name, 3.5));
    }
    const proposal = (await post(app, '/api/match-proposals')).json<MatchProposal>();
    await post(app, `/api/match-proposals/${proposal.id}/apply`, { courtId: 1 });
    await post(app, '/api/courts/1/start');
    expect((await post(app, '/api/sessions/close')).statusCode).toBe(409);
    expect((await post(app, '/api/settings', { ...(await state(app)).settings, courtCount: 2,
      courtNames: ['Court 1', 'Court 2'] })).statusCode).toBe(409);
    await post(app, '/api/courts/1/end');
    const archivedId = (await state(app)).session.id;
    expect((await post(app, '/api/sessions/close')).statusCode).toBe(200);
    expect((await post(app, `/api/players/${ids[0]}/attendance`, { attendance: 'resting' })).statusCode).toBe(409);
    const exported = await app.inject({ method: 'GET', url: `/api/sessions/export?kind=attendance&sessionId=${archivedId}`, headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain("'=HYPERLINK");
    expect(exported.body).toContain(ids[1]);
    expect(exported.body).toContain(ids[2]);
    const reopened = await post(app, '/api/sessions', { name: 'Next social', includePreviousRoster: true });
    expect(reopened.statusCode).toBe(201);
    const snapshot = reopened.json<AppSnapshot>();
    expect(snapshot.roster.map((player) => player.id).sort()).toEqual([...ids].sort());
    expect(snapshot.roster.every((player) => player.attendance === 'expected' && player.gamesPlayed === 0)).toBe(true);
    expect(snapshot.gameHistory).toHaveLength(0);
    expect(snapshot.session.id).not.toBe(archivedId);
    const oldMatches = await app.inject({ method: 'GET', url: `/api/sessions/export?kind=matches&sessionId=${archivedId}`, headers });
    expect(oldMatches.body).toContain(ids[0]);
  });

  it('isolates public visitors and makes display credentials incapable of host writes', async () => {
    const app = await open({ publicDemo: true });
    const a = (await post(app, '/api/visitor-sessions')).json<{ accessKey: string }>();
    const b = (await post(app, '/api/visitor-sessions')).json<{ accessKey: string }>();
    const authA = { authorization: `Bearer ${a.accessKey}` };
    const authB = { authorization: `Bearer ${b.accessKey}` };
    const originalB = await state(app, authB);
    const ownA = await state(app, authA);
    expect(ownA.roster[0]!.id).not.toBe(originalB.roster[0]!.id);
    const cross = await post(app, `/api/players/${originalB.roster[0]!.id}/attendance`, { attendance: 'resting' }, authA);
    expect(cross.statusCode).toBe(404);
    const display = (await post(app, '/api/display-access', undefined, authA)).json<{ accessKey: string }>();
    const readAuth = { authorization: `Bearer ${display.accessKey}` };
    const publicView = await app.inject({ method: 'GET', url: '/api/display', headers: readAuth });
    expect(publicView.statusCode).toBe(200);
    expect(publicView.headers['cache-control']).toContain('no-store');
    for (const field of ['externalId', 'source', 'skillRating', 'playStyle', 'roster']) expect(publicView.body).not.toContain(`"${field}"`);
    for (const url of ['/api/state', '/api/sessions/export?kind=attendance']) {
      expect((await app.inject({ method: 'GET', url, headers: readAuth })).statusCode).toBe(401);
    }
    for (const url of ['/api/visitor-reset', '/api/sessions/close', '/api/display-access', '/api/match-proposals']) {
      expect((await post(app, url, undefined, readAuth)).statusCode).toBe(401);
    }
    expect((await post(app, '/api/visitor-reset', undefined, authA)).statusCode).toBe(200);
    expect((await state(app, authB)).roster).toEqual(originalB.roster);
    expect((await state(app, authA)).roster.map((player) => player.id)).not.toEqual(ownA.roster.map((player) => player.id));
    expect((await app.inject({ method: 'GET', url: '/api/display', headers: readAuth })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/state', headers })).statusCode).toBe(401);
  });
});
