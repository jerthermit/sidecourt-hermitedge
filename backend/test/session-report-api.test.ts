import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import type { SessionReport } from '../src/models.js';

const KEY = 'fictional-host-session-key';
const apps: FastifyInstance[] = [];
const headers = (key = KEY) => ({ authorization: `Bearer ${key}` });
async function setup(overrides: Partial<AppConfig> = {}) {
  const repository = new Repository(':memory:');
  const config: AppConfig = { host: '127.0.0.1', port: 3000, operatorAccessKey: KEY,
    corsOrigins: ['http://localhost:5173'], databasePath: ':memory:', bodyLimit: 65_536,
    rateLimitMax: 1000, rateLimitWindow: '1 minute', demoSeed: false, ...overrides };
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('Reports must not call a provider'); });
  vi.stubGlobal('fetch', fetcher);
  const app = await buildApp({ config, repository });
  apps.push(app);
  return { app, repository, fetcher };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('protected session reports', () => {
  it('returns the selected authoritative session without provider access or cacheable private data', async () => {
    const { app, repository, fetcher } = await setup();
    repository.createPlayer({ name: 'Alex', skillLevel: 'unrated', skillRating: null, playStyle: 'Balanced' });
    const id = repository.getSnapshot().session.id;
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${id}/report`, headers: headers() });
    expect(response.statusCode).toBe(200);
    const report = response.json<SessionReport>();
    expect(report.session.id).toBe(id);
    expect(report.participants[0]?.name).toBe('Alex');
    expect(report.totals.completedMatches).toBe(0);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toMatch(/private-provider-key|fictional-model|accessKey/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('denies anonymous, incorrect and read-only display credentials', async () => {
    const { app, repository } = await setup();
    const id = repository.getSnapshot().session.id;
    const url = `/api/sessions/${id}/report`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url, headers: headers('incorrect') })).statusCode).toBe(401);
    const grant = await app.inject({ method: 'POST', url: '/api/display-access', headers: headers() });
    expect((await app.inject({ method: 'GET', url, headers: headers(grant.json<{ accessKey: string }>().accessKey) })).statusCode).toBe(401);
  });
  it('rejects malformed and missing session identifiers without changing state', async () => {
    const { app, repository } = await setup();
    const before = repository.getSnapshot();
    expect((await app.inject({ method: 'GET', url: '/api/sessions/not-a-uuid/report', headers: headers() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/00000000-0000-4000-8000-000000000000/report', headers: headers() })).statusCode).toBe(404);
    expect(repository.getSnapshot()).toEqual(before);
  });
  it('keeps reports isolated between temporary visitors and denies expired access', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { app } = await setup({ publicDemo: true, visitorTtlMs: 1000 });
    const first = (await app.inject({ method: 'POST', url: '/api/visitor-sessions' })).json<{ accessKey: string }>().accessKey;
    const second = (await app.inject({ method: 'POST', url: '/api/visitor-sessions' })).json<{ accessKey: string }>().accessKey;
    const state = (await app.inject({ method: 'GET', url: '/api/state', headers: headers(first) })).json<{ session: { id: string } }>();
    const url = `/api/sessions/${state.session.id}/report`;
    expect((await app.inject({ method: 'GET', url, headers: headers(first) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url, headers: headers(second) })).statusCode).toBe(404);
    now += 1001;
    expect((await app.inject({ method: 'GET', url, headers: headers(first) })).statusCode).toBe(401);
  });
});
