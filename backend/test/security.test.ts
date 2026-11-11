import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { Repository } from '../src/db.js';

const ACCESS_KEY = 'security-regression-operator-key';
const ORIGIN = 'https://club.example';
const authorization = { authorization: `Bearer ${ACCESS_KEY}` };
const apps: FastifyInstance[] = [];

async function makeApp(overrides: Partial<AppConfig> = {}) {
  const repository = new Repository(':memory:');
  const app = await buildApp({ repository, config: {
    host: '127.0.0.1', port: 3000, operatorAccessKey: ACCESS_KEY,
    corsOrigins: [ORIGIN], databasePath: ':memory:', bodyLimit: 65_536,
    rateLimitMax: 1000, rateLimitWindow: '1 minute', demoSeed: false,
    ...overrides,
  } });
  apps.push(app);
  return { app, repository };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('HTTP security boundaries', () => {
  it('rejects untrusted browser origins before public boards can be allocated', async () => {
    const { app } = await makeApp({ publicDemo: true, maxVisitors: 1 });
    for (const url of ['/api/visitor-sessions', '/%61pi/visitor-sessions', '/%61%70%69/visitor-sessions']) {
      for (const origin of ['https://untrusted.example', `${ORIGIN}.untrusted.example`, `${ORIGIN}/path`, 'null']) {
        const blocked = await app.inject({ method: 'POST', url, headers: { origin } });
        expect(blocked.statusCode).toBe(403);
        expect(blocked.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
        expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
      }
    }
    const permitted = await app.inject({ method: 'POST', url: '/api/visitor-sessions', headers: { origin: ORIGIN } });
    expect(permitted.statusCode).toBe(201);
    expect(permitted.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('authenticates and prevents caching on percent-encoded API aliases', async () => {
    const { app } = await makeApp({ publicDemo: true });
    const created = await app.inject({ method: 'POST', url: '/%61pi/visitor-sessions', headers: { origin: ORIGIN } });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const visitorAuthorization = { authorization: `Bearer ${created.json<{ accessKey: string }>().accessKey}` };
    const state = await app.inject({ method: 'GET', url: '/%61pi/state', headers: visitorAuthorization });
    expect(state.statusCode).toBe(200);
    expect(state.headers['cache-control']).toBe('no-store');
    const grant = await app.inject({ method: 'POST', url: '/api/display-access', headers: visitorAuthorization });
    const display = await app.inject({ method: 'GET', url: '/%61pi/display',
      headers: { authorization: `Bearer ${grant.json<{ accessKey: string }>().accessKey}` } });
    expect(display.statusCode).toBe(200);
    expect(display.headers['cache-control']).toBe('no-store');
    expect(display.body).not.toContain('"roster"');
    expect((await app.inject({ method: 'GET', url: '/%61pi/state' })).statusCode).toBe(401);
  });

  it('rejects untrusted browser writes without changing the board and permits operator tooling without Origin', async () => {
    const { app, repository } = await makeApp();
    const before = repository.getSnapshot();
    const auditBefore = repository.getAuditEntriesForTests();
    const payload = { name: 'Operator entry', skillLevel: 'unrated', playStyle: 'Balanced' };
    const blocked = await app.inject({ method: 'POST', url: '/api/players',
      headers: { ...authorization, origin: 'https://untrusted.example' }, payload });
    expect(blocked.statusCode).toBe(403);
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(auditBefore);
    expect((await app.inject({ method: 'POST', url: '/api/players', headers: authorization, payload })).statusCode).toBe(201);
  });

  it('permits only configured-origin preflights without requiring an access key', async () => {
    const { app } = await makeApp();
    const preflight = (origin: string) => app.inject({ method: 'OPTIONS', url: '/api/players', headers: {
      origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type',
    } });
    const allowed = await preflight(ORIGIN);
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(ORIGIN);
    const denied = await preflight('https://untrusted.example');
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps successful and rejected API responses uncacheable and non-executable', async () => {
    const { app } = await makeApp({ rateLimitMax: 2 });
    const responses = [
      await app.inject({ method: 'GET', url: '/api/state', headers: authorization }),
      await app.inject({ method: 'GET', url: '/api/state' }),
      await app.inject({ method: 'GET', url: '/api/state', headers: authorization }),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([200, 401, 429]);
    for (const response of responses) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    }
  });

  it('bounds normal and roster payloads and preserves safe client-error responses without writes', async () => {
    const { app, repository } = await makeApp();
    const before = repository.getSnapshot();
    const auditBefore = repository.getAuditEntriesForTests();
    for (const url of ['/api/players', '/api/roster/import']) {
      const malformed = await app.inject({ method: 'POST', url,
        headers: { ...authorization, 'content-type': 'application/json' }, payload: '{private-invalid-input' });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.body).not.toContain('private-invalid-input');
      const oversized = await app.inject({ method: 'POST', url,
        headers: { ...authorization, 'content-type': 'application/json' },
        payload: JSON.stringify({ padding: 'x'.repeat(url.includes('roster') ? 512 * 1024 : 65_536) }) });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json().error.code).toBe('BODY_TOO_LARGE');
    }
    const unsupported = await app.inject({ method: 'POST', url: '/api/players',
      headers: { ...authorization, 'content-type': 'application/private-input' }, payload: 'private-input' });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toEqual({ error: {
      code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use a supported request content type.',
    } });
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(auditBefore);
  });

  it('does not expose unexpected internal errors or promise that an uncertain write failed', async () => {
    const { app, repository } = await makeApp();
    vi.spyOn(repository, 'getSnapshot').mockImplementation(() => {
      throw new Error('private-database-path internal stack SQL SELECT');
    });
    const response = await app.inject({ method: 'GET', url: '/api/state', headers: authorization });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: {
      code: 'INTERNAL_ERROR',
      message: 'The operation could not be confirmed. Refresh to check the latest state before retrying.',
    } });
    expect(response.body).not.toMatch(/private-database-path|stack|SQL/);
  });
});

describe('private access-key configuration', () => {
  it.each([' '.repeat(32), 'x'.repeat(513), `valid-length-key\nextra`])('rejects unusable private credentials', (key) => {
    expect(() => loadConfig({ OPERATOR_ACCESS_KEY: key })).toThrow('OPERATOR_ACCESS_KEY');
  });

  it('accepts a bounded private secret and leaves public mode independent of an operator secret', () => {
    expect(loadConfig({ OPERATOR_ACCESS_KEY: 'x'.repeat(512) }).operatorAccessKey).toHaveLength(512);
    expect(loadConfig({ PUBLIC_DEMO: 'true' }).operatorAccessKey).toBe('');
  });
});
