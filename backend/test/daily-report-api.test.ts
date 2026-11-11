import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import type { DailyReport } from '../src/models.js';

const KEY = 'fictional-daily-report-key';
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

describe('protected daily reports', () => {
  it('returns the requested date, no provider calls, no private identifiers and no cacheable response', async () => {
    const { app, repository, fetcher } = await setup();
    const before = repository.getSnapshot();
    const response = await app.inject({ method: 'GET', url: '/api/reports/daily?date=2026-02-28', headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json<DailyReport>()).toMatchObject({ date: '2026-02-28',
      displayTimezone: 'Australia/Sydney', totals: { checkedInPlayers: 0, completedMatches: 0 }, matches: [] });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toMatch(/accessKey|externalId|operatorAccessKey|fictional-daily-report-key|source/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(repository.getSnapshot()).toEqual(before);
  });

  it.each(['/api/reports/daily', '/api/reports/daily?date=2026-02-30',
    '/api/reports/daily?date=2025-02-29', '/api/reports/daily?date=2026-1-01',
    '/api/reports/daily?date=2026-01-01&timezone=UTC', '/api/reports/daily?date=2026-01-01&date=2026-01-02'])
  ('rejects malformed, impossible and unexpected query values: %s', async (url) => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url, headers: headers() })).statusCode).toBe(400);
  });

  it('accepts a valid leap day', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/reports/daily?date=2028-02-29', headers: headers() })).statusCode).toBe(200);
  });

  it('rejects anonymous, incorrect and read-only display credentials and keeps report data out of the display', async () => {
    const { app } = await setup();
    const url = '/api/reports/daily?date=2026-11-07';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url, headers: headers('incorrect') })).statusCode).toBe(401);
    const accessKey = (await app.inject({ method: 'POST', url: '/api/display-access', headers: headers() }))
      .json<{ accessKey: string }>().accessKey;
    expect((await app.inject({ method: 'GET', url, headers: headers(accessKey) })).statusCode).toBe(401);
    const display = await app.inject({ method: 'GET', url: '/api/display', headers: headers(accessKey) });
    expect(display.statusCode).toBe(200);
    for (const field of ['totals', 'matches', 'sessions', 'participants', 'checkedInPlayers', 'completedCourtSeconds']) {
      expect(display.body).not.toContain(`"${field}"`);
    }
  });

  it('isolates each visitor’s date report and denies expired access', async () => {
    let now = Date.parse('2026-11-07T02:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { app } = await setup({ publicDemo: true, visitorTtlMs: 1000 });
    const keys: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      keys.push((await app.inject({ method: 'POST', url: '/api/visitor-sessions' })).json<{ accessKey: string }>().accessKey);
    }
    const url = '/api/reports/daily?date=2026-11-07';
    const first = (await app.inject({ method: 'GET', url, headers: headers(keys[0]!) })).json<DailyReport>();
    const second = (await app.inject({ method: 'GET', url, headers: headers(keys[1]!) })).json<DailyReport>();
    expect(first.matches).not.toHaveLength(0);
    expect(first.totals).toEqual(second.totals);
    const firstIdentities = new Set(first.matches.flatMap((match) => match.playerIds));
    expect(second.matches.every((match) => match.playerIds.every((id) => !firstIdentities.has(id)))).toBe(true);
    const voided = first.matches.find((match) => match.status === 'completed')!;
    expect((await app.inject({ method: 'POST', url: `/api/games/${voided.id}/void`,
      headers: headers(keys[0]!), payload: { reason: 'Duplicate result' } })).statusCode).toBe(200);
    const changed = (await app.inject({ method: 'GET', url, headers: headers(keys[0]!) })).json<DailyReport>();
    expect(changed.totals.completedMatches).toBe(first.totals.completedMatches - 1);
    expect((await app.inject({ method: 'GET', url, headers: headers(keys[1]!) })).json<DailyReport>().totals).toEqual(second.totals);
    now += 1001;
    expect((await app.inject({ method: 'GET', url, headers: headers(keys[0]!) })).statusCode).toBe(401);
  });
});
