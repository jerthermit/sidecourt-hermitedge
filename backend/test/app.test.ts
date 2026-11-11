import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import type { AppSnapshot, Attendance, MatchProposal, RosterImportPreview, RosterImportRow } from '../src/models.js';

const ACCESS_KEY = 'test-operator-access-key-123456';
const openApps: FastifyInstance[] = [];
const openRepositories: Repository[] = [];
const temporaryDirectories: string[] = [];

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    operatorAccessKey: ACCESS_KEY,
    corsOrigins: ['http://localhost:5173'],
    databasePath: ':memory:',
    bodyLimit: 65_536,
    rateLimitMax: 10_000,
    rateLimitWindow: '1 minute',
    demoSeed: false,
    ...overrides,
  };
}

async function makeApp(options: {
  config?: Partial<AppConfig>;
} = {}): Promise<{ app: FastifyInstance; repository: Repository }> {
  const repository = new Repository(':memory:');
  const config = testConfig(options.config);
  const app = await buildApp({
    config,
    repository,
  });
  openApps.push(app);
  return { app, repository };
}

const authHeaders = { authorization: `Bearer ${ACCESS_KEY}` };

async function createPlayer(
  app: FastifyInstance,
  name: string,
  skillRating = 3.5,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/players',
    headers: authHeaders,
    payload: {
      name,
      skillLevel: 'intermediate',
      skillRating,
      playStyle: 'Balanced',
    },
  });
  expect(response.statusCode).toBe(201);
  const snapshot = response.json<AppSnapshot>();
  return snapshot.holdingPool.find((player) => player.name === name)!.id;
}

async function move(
  app: FastifyInstance,
  playerId: string,
  destination: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: `/api/players/${playerId}/move`,
    headers: authHeaders,
    payload: { destination },
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  for (const repository of openRepositories.splice(0)) repository.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true });
});

function importRow(externalId: string, name = `Roster ${externalId}`): RosterImportRow {
  return { externalId, name, skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced' };
}

async function rosterRequest(
  app: FastifyInstance,
  operation: 'preview' | 'import',
  rows: RosterImportRow[],
  source = 'test-roster',
) {
  return app.inject({
    method: 'POST', url: `/api/roster/${operation}`, headers: authHeaders,
    payload: { source, rows },
  });
}

async function attendance(app: FastifyInstance, id: string, status: Attendance) {
  return app.inject({
    method: 'POST', url: `/api/players/${id}/attendance`, headers: authHeaders,
    payload: { attendance: status },
  });
}

describe('operator API', () => {
  it('seeds the Australian club roster only when explicitly enabled', async () => {
    const { app, repository } = await makeApp({ config: { demoSeed: true } });
    const state = await app.inject({ method: 'GET', url: '/api/state', headers: authHeaders });
    const snapshot = state.json<AppSnapshot>();

    expect(snapshot.holdingPool).toHaveLength(6);
    expect(snapshot.holdingPool.map((player) => player.name)).toEqual([
      'Maddie Hartwell', 'Lachie Dempsey', 'Amelia Chen',
      'Ethan McAllister', 'Zara Kapoor', 'Harrison Bellamy',
    ]);
    expect(snapshot.roster).toHaveLength(10);
    expect(snapshot.roster.every((player) => player.attendance === 'ready'
      && player.source === null && player.externalId === null)).toBe(true);
    expect(snapshot.nextGamePool.intermediate).toHaveLength(4);
    expect(snapshot.nextGamePool.intermediate.map((player) => player.name)).toEqual([
      'Priya Narayan', 'Noah Tran', 'Chloe Fairbairn', 'Oliver Haddad',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('Demo Player');
    const auditBefore = repository.getAuditEntriesForTests();
    repository.seedRecordingFixture();
    expect(repository.getSnapshot()).toEqual(snapshot);
    expect(repository.getAuditEntriesForTests()).toEqual(auditBefore);
  });

  it('preserves an existing roster and its IDs when recording seeding is requested again', async () => {
    const { app, repository } = await makeApp();
    await createPlayer(app, 'Mika Santos', 4.2);
    const before = repository.getSnapshot();
    const auditBefore = repository.getAuditEntriesForTests();

    repository.seedRecordingFixture();
    repository.seedRecordingFixture();

    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(auditBefore);
  });

  it('keeps health public and protects every API route', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { authorization: 'Bearer incorrect-key-value' },
    })).statusCode).toBe(401);
    const state = await app.inject({ method: 'GET', url: '/api/state', headers: authHeaders });
    expect(state.statusCode).toBe(200);
    expect(state.json<AppSnapshot>().courts).toHaveLength(6);
  });

  it('completes the authoritative player, court, game, and history lifecycle', async () => {
    const { app, repository } = await makeApp();
    repository.updateSettings({ ...repository.getSettings(), gameMode: 'singles' });
    const first = await createPlayer(app, 'Player One');
    const second = await createPlayer(app, 'Player Two');
    expect((await move(app, first, { type: 'court', courtId: 1 })).statusCode).toBe(200);
    expect((await move(app, second, { type: 'court', courtId: 1 })).statusCode).toBe(200);

    const started = await app.inject({
      method: 'POST', url: '/api/courts/1/start', headers: authHeaders,
    });
    expect(started.statusCode).toBe(200);
    expect(started.json<AppSnapshot>().courts[0]!.status).toBe('in-play');

    const locked = await move(app, first, { type: 'holding-pool' });
    expect(locked.statusCode).toBe(409);

    const ended = await app.inject({
      method: 'POST', url: '/api/courts/1/end', headers: authHeaders,
    });
    expect(ended.statusCode).toBe(200);
    const snapshot = ended.json<AppSnapshot>();
    expect(snapshot.courts[0]!.status).toBe('available');
    expect(snapshot.courts[0]!.players).toHaveLength(0);
    expect(snapshot.holdingPool.map((player) => player.id)).toEqual([first, second]);
    expect(snapshot.gameHistory[0]!.players).toEqual(['Player One', 'Player Two']);
  });

  it('preserves the 429 rate-limit contract and retry header without mutating state', async () => {
    const { app, repository } = await makeApp({ config: { rateLimitMax: 2 } });
    await createPlayer(app, 'Rate limit fixture');
    expect((await app.inject({ method: 'GET', url: '/api/state', headers: authHeaders })).statusCode).toBe(200);
    const before = repository.getSnapshot();
    const auditBefore = repository.getAuditEntriesForTests();
    const blocked = await app.inject({
      method: 'POST', url: '/api/players', headers: authHeaders,
      payload: { name: 'Must not be added', skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: {
      code: 'RATE_LIMITED', message: 'Too many requests. Please retry shortly.',
    } });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    const repeated = await app.inject({ method: 'GET', url: '/api/state', headers: authHeaders });
    expect(repeated.statusCode).toBe(429);
    expect(repeated.json().error.code).toBe('RATE_LIMITED');
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(auditBefore);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('moves within holding by explicit index without duplicate membership or position gaps', async () => {
    const { app, repository } = await makeApp();
    const ids: string[] = [];
    for (const name of ['Holding A', 'Holding B', 'Holding C']) ids.push(await createPlayer(app, name));
    const [first, second, third] = ids as [string, string, string];
    for (const [targetIndex, expectedIds] of [
      [2, [second, third, first]],
      [0, [first, second, third]],
      [1, [second, first, third]],
      [1, [second, first, third]],
    ] as Array<[number, string[]]>) {
      const response = await move(app, first, { type: 'holding-pool', index: targetIndex });
      expect(response.statusCode).toBe(200);
      const snapshot = response.json<AppSnapshot>();
      expect(snapshot.holdingPool.map((player) => player.id)).toEqual(expectedIds);
      expect(snapshot.holdingPool.map((player) => player.location)).toEqual([
        { type: 'holding-pool', index: 0 }, { type: 'holding-pool', index: 1 }, { type: 'holding-pool', index: 2 },
      ]);
      expect(new Set(snapshot.holdingPool.map((player) => player.id)).size).toBe(3);
      expect(snapshot.roster).toHaveLength(3);
    }
    const before = repository.getSnapshot();
    const auditBefore = repository.getAuditEntriesForTests();
    expect((await move(app, first, { type: 'holding-pool', index: 3 })).statusCode).toBe(400);
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(auditBefore);
    expect((await move(app, third, { type: 'court', courtId: 1 })).statusCode).toBe(200);
    const returning = await move(app, third, { type: 'holding-pool', index: 2 });
    expect(returning.statusCode).toBe(200);
    expect(returning.json<AppSnapshot>().holdingPool.map((player) => player.id)).toEqual([second, first, third]);
    expect(returning.json<AppSnapshot>().holdingPool.map((player) => player.location)).toEqual([
      { type: 'holding-pool', index: 0 }, { type: 'holding-pool', index: 1 }, { type: 'holding-pool', index: 2 },
    ]);
  });

  it('keeps same next-game lane moves idempotent and appends cross-lane moves once', async () => {
    const { app, repository } = await makeApp();
    const first = await createPlayer(app, 'Lane A');
    const second = await createPlayer(app, 'Lane B');
    const third = await createPlayer(app, 'Lane C');
    expect((await move(app, first, { type: 'next-game-pool', lane: 'intermediate' })).statusCode).toBe(200);
    expect((await move(app, second, { type: 'next-game-pool', lane: 'intermediate' })).statusCode).toBe(200);
    expect((await move(app, third, { type: 'next-game-pool', lane: 'advanced' })).statusCode).toBe(200);
    const before = repository.getSnapshot();
    const auditBefore = repository.getAuditEntriesForTests();
    const repeated = await Promise.all(Array.from({ length: 8 }, () =>
      move(app, first, { type: 'next-game-pool', lane: 'intermediate' })));
    expect(repeated.every((response) => response.statusCode === 200)).toBe(true);
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(auditBefore);
    const crossing = await move(app, first, { type: 'next-game-pool', lane: 'advanced' });
    expect(crossing.statusCode).toBe(200);
    const snapshot = crossing.json<AppSnapshot>();
    expect(snapshot.nextGamePool.intermediate.map((player) => player.id)).toEqual([second]);
    expect(snapshot.nextGamePool.intermediate[0]!.location).toEqual({
      type: 'next-game-pool', lane: 'intermediate', index: 0,
    });
    expect(snapshot.nextGamePool.advanced.map((player) => player.id)).toEqual([third, first]);
    expect(snapshot.nextGamePool.advanced.map((player) => player.location)).toEqual([
      { type: 'next-game-pool', lane: 'advanced', index: 0 },
      { type: 'next-game-pool', lane: 'advanced', index: 1 },
    ]);
    expect(snapshot.roster).toHaveLength(3);
    expect(snapshot.holdingPool).toHaveLength(0);
  });

  it('dismisses expired proposals idempotently while leaving the expiry terminal state intact', async () => {
    const { app, repository } = await makeApp();
    for (const name of ['Expiry A', 'Expiry B', 'Expiry C', 'Expiry D']) await createPlayer(app, name);
    const proposalResponse = await app.inject({ method: 'POST', url: '/api/match-proposals', headers: authHeaders });
    expect(proposalResponse.statusCode).toBe(201);
    const proposal = proposalResponse.json<MatchProposal>();
    const before = repository.getSnapshot();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(proposal.expiresAt + 1);
    try {
      const firstDismissal = await app.inject({
        method: 'POST', url: `/api/match-proposals/${proposal.id}/reject`, headers: authHeaders,
      });
      expect(firstDismissal.statusCode).toBe(200);
      expect(firstDismissal.json<MatchProposal>()).toMatchObject({ id: proposal.id, status: 'expired' });
      const repeated = await app.inject({
        method: 'POST', url: `/api/match-proposals/${proposal.id}/reject`, headers: authHeaders,
      });
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json<MatchProposal>()).toEqual(firstDismissal.json<MatchProposal>());
      const applied = await app.inject({
        method: 'POST', url: `/api/match-proposals/${proposal.id}/apply`, headers: authHeaders,
      });
      expect(applied.statusCode).toBe(409);
      expect(applied.json().error.message).toContain('expired');
      const after = repository.getSnapshot();
      expect(after.roster).toEqual(before.roster);
      expect(after.holdingPool).toEqual(before.holdingPool);
      expect(after.nextGamePool).toEqual(before.nextGamePool);
      expect(after.matchProposals).toHaveLength(0);
      expect(repository.getAuditEntriesForTests().filter((entry) => entry.action === 'match_proposal.rejected')).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects pending proposals once and returns the same rejected result on retries', async () => {
    const { app, repository } = await makeApp();
    for (const name of ['Reject A', 'Reject B', 'Reject C', 'Reject D']) await createPlayer(app, name);
    const proposal = (await app.inject({
      method: 'POST', url: '/api/match-proposals', headers: authHeaders,
    })).json<MatchProposal>();
    const before = repository.getSnapshot();
    const first = await app.inject({
      method: 'POST', url: `/api/match-proposals/${proposal.id}/reject`, headers: authHeaders,
    });
    const repeated = await app.inject({
      method: 'POST', url: `/api/match-proposals/${proposal.id}/reject`, headers: authHeaders,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<MatchProposal>().status).toBe('rejected');
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json<MatchProposal>()).toEqual(first.json<MatchProposal>());
    expect(repository.getAuditEntriesForTests().filter((entry) => entry.action === 'match_proposal.rejected')).toHaveLength(1);
    expect(repository.getSnapshot().roster).toEqual(before.roster);
    expect(repository.getSnapshot().holdingPool).toEqual(before.holdingPool);
    const attemptedApply = await app.inject({
      method: 'POST', url: `/api/match-proposals/${proposal.id}/apply`, headers: authHeaders,
    });
    expect(attemptedApply.statusCode).toBe(409);
    expect(attemptedApply.json().error.message).toContain('rejected');
  });

  it('never silently rejects an applied proposal, even after its original expiry', async () => {
    const { app, repository } = await makeApp();
    for (const name of ['Applied A', 'Applied B', 'Applied C', 'Applied D']) await createPlayer(app, name);
    const proposal = (await app.inject({
      method: 'POST', url: '/api/match-proposals', headers: authHeaders,
    })).json<MatchProposal>();
    const applied = await app.inject({
      method: 'POST', url: `/api/match-proposals/${proposal.id}/apply`, headers: authHeaders,
    });
    expect(applied.statusCode).toBe(200);
    const appliedState = applied.json<AppSnapshot>();
    const auditBefore = repository.getAuditEntriesForTests();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(proposal.expiresAt + 1);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const rejected = await app.inject({
          method: 'POST', url: `/api/match-proposals/${proposal.id}/reject`, headers: authHeaders,
        });
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json().error.message).toContain('applied');
      }
      const state = await app.inject({ method: 'GET', url: '/api/state', headers: authHeaders });
      expect(state.json<AppSnapshot>()).toEqual(appliedState);
      expect(repository.getAuditEntriesForTests()).toEqual(auditBefore);
    } finally {
      clock.mockRestore();
    }
  });

  it('rolls back an invalid three-player start', async () => {
    const { app } = await makeApp();
    const ids = await Promise.all([
      createPlayer(app, 'First'),
      createPlayer(app, 'Second'),
      createPlayer(app, 'Third'),
    ]);
    for (const id of ids) expect((await move(app, id, { type: 'court', courtId: 2 })).statusCode).toBe(200);

    const failed = await app.inject({
      method: 'POST', url: '/api/courts/2/start', headers: authHeaders,
    });
    expect(failed.statusCode).toBe(409);
    const state = await app.inject({ method: 'GET', url: '/api/state', headers: authHeaders });
    const court = state.json<AppSnapshot>().courts[1]!;
    expect(court.status).toBe('available');
    expect(court.gameStartedAt).toBeNull();
    expect(court.players).toHaveLength(3);
  });

  it('applies only approved, still-current proposals and rejects stale ones atomically', async () => {
    const { app } = await makeApp();
    for (const name of ['A', 'B', 'C', 'D']) await createPlayer(app, name);
    const proposalResponse = await app.inject({
      method: 'POST', url: '/api/match-proposals', headers: authHeaders,
    });
    const proposal = proposalResponse.json<MatchProposal>();
    const applied = await app.inject({
      method: 'POST',
      url: `/api/match-proposals/${proposal.id}/apply`,
      headers: authHeaders,
    });
    expect(applied.statusCode).toBe(200);
    const appliedState = applied.json<AppSnapshot>();
    expect(appliedState.nextGamePool[proposal.targetLane]).toHaveLength(4);
    expect(appliedState.holdingPool).toHaveLength(0);

    for (const name of ['E', 'F', 'G', 'H']) await createPlayer(app, name);
    const staleProposal = (await app.inject({
      method: 'POST', url: '/api/match-proposals', headers: authHeaders,
    })).json<MatchProposal>();
    expect((await move(app, staleProposal.playerIds[0]!, {
      type: 'next-game-pool', lane: 'beginner',
    })).statusCode).toBe(200);
    const staleApply = await app.inject({
      method: 'POST',
      url: `/api/match-proposals/${staleProposal.id}/apply`,
      headers: authHeaders,
    });
    expect(staleApply.statusCode).toBe(409);
    const state = (await app.inject({
      method: 'GET', url: '/api/state', headers: authHeaders,
    })).json<AppSnapshot>();
    expect(state.holdingPool).toHaveLength(3);
    expect(state.nextGamePool.beginner).toHaveLength(1);
  });
});

describe('roster imports and attendance', () => {
  it('previews without writes, imports expected players, and skips an exact retry', async () => {
    const { app, repository } = await makeApp();
    const rows = [importRow(' A-1 ', ' Alice '), importRow('A-2', 'Bob')];
    const previewResponse = await rosterRequest(app, 'preview', rows, '  CLUB LIST  ');
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json<RosterImportPreview>();
    expect(preview.source).toBe('club list');
    expect(preview.rows[0]).toMatchObject({ externalId: 'A-1', name: 'Alice', status: 'new', message: null });
    expect([preview.newCount, preview.existingCount, preview.conflictCount]).toEqual([2, 0, 0]);
    expect(repository.getSnapshot().roster).toHaveLength(0);
    expect(repository.getAuditEntriesForTests()).toHaveLength(0);

    const imported = await rosterRequest(app, 'import', rows, 'Club List');
    expect(imported.statusCode).toBe(200);
    const result = imported.json<{ snapshot: AppSnapshot; added: number; skipped: number }>();
    expect([result.added, result.skipped]).toEqual([2, 0]);
    expect(result.snapshot.roster).toHaveLength(2);
    expect(result.snapshot.roster.every((player) => player.attendance === 'expected'
      && player.source === 'club list')).toBe(true);
    expect(result.snapshot.holdingPool).toHaveLength(0);
    expect(repository.getHoldingCandidates()).toHaveLength(0);
    const alice = result.snapshot.roster.find((player) => player.externalId === 'A-1')!;
    expect((await attendance(app, alice.id, 'ready')).statusCode).toBe(200);

    const existing = (await rosterRequest(app, 'preview', rows, 'CLUB LIST')).json<RosterImportPreview>();
    expect(existing.rows.map((row) => row.status)).toEqual(['existing', 'existing']);
    const retried = (await rosterRequest(app, 'import', rows, 'club list')).json<{
      snapshot: AppSnapshot; added: number; skipped: number;
    }>();
    expect([retried.added, retried.skipped]).toEqual([0, 2]);
    expect(retried.snapshot.roster.map((player) => player.id).sort()).toEqual(
      result.snapshot.roster.map((player) => player.id).sort(),
    );
    expect(retried.snapshot.holdingPool.map((player) => player.id)).toEqual([alice.id]);
  });

  it.each([
    { name: 'Different name' },
    { skillLevel: 'advanced' as const },
    { skillRating: 4.5 },
    { playStyle: 'Tactical' as const },
  ])('rejects changed player details and atomically preserves the roster: %j', async (changes) => {
    const { app, repository } = await makeApp();
    const original = importRow('stable-id');
    await rosterRequest(app, 'import', [original]);
    const before = repository.getSnapshot();
    const beforeAudit = repository.getAuditEntriesForTests();
    const rows = [importRow('would-be-new'), { ...original, ...changes }];
    const preview = (await rosterRequest(app, 'preview', rows)).json<RosterImportPreview>();
    expect(preview.rows.map((row) => row.status)).toEqual(['new', 'conflict']);
    expect(preview.conflictCount).toBe(1);
    expect(preview.rows[1]!.message).toBeTruthy();
    expect((await rosterRequest(app, 'import', rows)).statusCode).toBe(409);
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(beforeAudit);
  });

  it('revalidates at commit after an earlier preview', async () => {
    const { app, repository } = await makeApp();
    const rows = [importRow('first'), importRow('second')];
    expect((await rosterRequest(app, 'preview', rows)).json<RosterImportPreview>().newCount).toBe(2);
    await rosterRequest(app, 'import', [{ ...rows[1]!, skillRating: 5 }]);
    expect((await rosterRequest(app, 'import', rows)).statusCode).toBe(409);
    expect(repository.getSnapshot().roster.map((player) => player.externalId)).toEqual(['second']);
  });

  it('uses source plus case-sensitive external IDs and never merges by name', async () => {
    const { app, repository } = await makeApp();
    const legacyId = await createPlayer(app, 'Same Name');
    await rosterRequest(app, 'import', [importRow('CaseID', 'Same Name'), importRow('caseid', 'Same Name')], ' SOURCE ');
    await rosterRequest(app, 'import', [importRow('CaseID', 'Same Name')], 'Other Source');
    const snapshot = repository.getSnapshot();
    expect(snapshot.roster).toHaveLength(4);
    expect(snapshot.holdingPool.map((player) => player.id)).toEqual([legacyId]);
    expect(snapshot.roster.filter((player) => player.source === 'source').map((player) => player.externalId).sort())
      .toEqual(['CaseID', 'caseid']);
    expect(snapshot.roster.find((player) => player.id === legacyId)).toMatchObject({
      attendance: 'ready', source: null, externalId: null,
    });
  });

  it('checks in at the queue tail and detaches rest or departure from queues and idle courts', async () => {
    const { app, repository } = await makeApp();
    await rosterRequest(app, 'import', ['a', 'b', 'c'].map((id) => importRow(id)));
    const ids = ['a', 'b', 'c'].map((id) => repository.getSnapshot().roster.find((player) => player.externalId === id)!.id);
    const [first, second, third] = ids as [string, string, string];
    for (const id of ids) expect((await attendance(app, id, 'ready')).statusCode).toBe(200);
    const initial = repository.getSnapshot();
    expect(initial.holdingPool.map((player) => player.id)).toEqual(ids);
    expect((await attendance(app, first, 'ready')).json<AppSnapshot>().holdingPool).toEqual(initial.holdingPool);
    await move(app, first, { type: 'next-game-pool', lane: 'advanced' });
    const rested = (await attendance(app, first, 'resting')).json<AppSnapshot>();
    expect(rested.nextGamePool.advanced).toHaveLength(0);
    expect(rested.holdingPool.map((player) => player.id)).toEqual([second, third]);
    expect(rested.holdingPool.map((player) => player.location)).toEqual([
      { type: 'holding-pool', index: 0 }, { type: 'holding-pool', index: 1 },
    ]);
    const returned = (await attendance(app, first, 'ready')).json<AppSnapshot>();
    expect(returned.holdingPool.map((player) => player.id)).toEqual([second, third, first]);
    await move(app, second, { type: 'court', courtId: 2 });
    const departed = (await attendance(app, second, 'departed')).json<AppSnapshot>();
    expect(departed.courts[1]!.players).toHaveLength(0);
    expect(departed.holdingPool.map((player) => player.id)).toEqual([third, first]);
    expect(departed.roster.find((player) => player.id === second)!.attendance).toBe('departed');
    const checkedInAgain = (await attendance(app, second, 'ready')).json<AppSnapshot>();
    expect(checkedInAgain.holdingPool.map((player) => player.id)).toEqual([third, first, second]);
    await attendance(app, third, 'expected');
    expect(repository.getSnapshot().holdingPool.map((player) => player.location)).toEqual([
      { type: 'holding-pool', index: 0 }, { type: 'holding-pool', index: 1 },
    ]);
    expect(repository.getSnapshot().roster).toHaveLength(3);
  });

  it('rejects attendance changes during an active match while allowing an idempotent status', async () => {
    const { app, repository } = await makeApp();
    repository.updateSettings({ ...repository.getSettings(), gameMode: 'singles' });
    const first = await createPlayer(app, 'Active one');
    const second = await createPlayer(app, 'Active two');
    for (const id of [first, second]) await move(app, id, { type: 'court', courtId: 1 });
    await app.inject({ method: 'POST', url: '/api/courts/1/start', headers: authHeaders });
    for (const status of ['expected', 'resting', 'departed'] as const) {
      expect((await attendance(app, first, status)).statusCode).toBe(409);
    }
    expect((await attendance(app, first, 'ready')).statusCode).toBe(200);
    const active = repository.getSnapshot();
    expect(active.courts[0]!.players.map((player) => player.id)).toEqual([first, second]);
    expect(active.roster.every((player) => player.attendance === 'ready')).toBe(true);
    await app.inject({ method: 'POST', url: '/api/courts/1/end', headers: authHeaders });
    expect((await attendance(app, first, 'resting')).statusCode).toBe(200);
    expect(repository.getSnapshot().gameHistory).toHaveLength(1);
  });

  it('excludes nonready players from moves, reordering, candidate selection, and proposal commits', async () => {
    const { app, repository } = await makeApp();
    await rosterRequest(app, 'import', ['a', 'b', 'c', 'd', 'e'].map((id) => importRow(id)));
    const ids = ['a', 'b', 'c', 'd', 'e'].map((id) => repository.getSnapshot().roster.find((player) => player.externalId === id)!.id);
    const expected = ids[4]!;
    for (const destination of [{ type: 'holding-pool' }, { type: 'next-game-pool', lane: 'beginner' }, { type: 'court', courtId: 1 }]) {
      expect((await move(app, expected, destination)).statusCode).toBe(409);
    }
    expect((await app.inject({
      method: 'POST', url: '/api/holding/reorder', headers: authHeaders,
      payload: { playerId: expected, targetIndex: 0 },
    })).statusCode).toBe(409);
    for (const id of ids.slice(0, 4)) await attendance(app, id, 'ready');
    expect(repository.getHoldingCandidates().map((player) => player.id)).toEqual(ids.slice(0, 4));
    const proposal = (await app.inject({ method: 'POST', url: '/api/match-proposals', headers: authHeaders })).json<MatchProposal>();
    await attendance(app, proposal.playerIds[0]!, 'resting');
    expect((await app.inject({
      method: 'POST', url: `/api/match-proposals/${proposal.id}/apply`, headers: authHeaders,
    })).statusCode).toBe(409);
    expect(() => repository.persistProposal({ source: 'rules-fallback', playerIds: [...ids.slice(1, 4), expected], notice: 'test' }))
      .toThrow('holding roster changed');
    expect(repository.getSnapshot().nextGamePool.intermediate).toHaveLength(0);
    expect(repository.getHoldingCandidates()).toHaveLength(3);
  });

  it('protects new endpoints and rejects malformed or ambiguous import requests without writes', async () => {
    const { app, repository } = await makeApp();
    const id = await createPlayer(app, 'Validation player');
    for (const url of ['/api/roster/preview', '/api/roster/import', `/api/players/${id}/attendance`]) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer wrong' }, payload: {} })).statusCode).toBe(401);
    }
    const invalidPayloads: unknown[] = [
      {}, { source: ' ', rows: [importRow('one')] },
      { source: 'x'.repeat(81), rows: [importRow('one')] },
      { source: 'x', rows: [] },
      { source: 'x', rows: Array.from({ length: 201 }, (_, index) => importRow(String(index))) },
      { source: 'x', rows: [importRow('')] },
      { source: 'x', rows: [importRow('x'.repeat(101))] },
      { source: 'x', rows: [importRow('same'), importRow(' same ')] },
      { source: 'x', rows: [{ ...importRow('one'), skillRating: 0 }] },
      { source: 'x', rows: [{ ...importRow('one'), skillRating: 6.1 }] },
      { source: 'x', rows: [{ ...importRow('one'), skillLevel: 'expert' }] },
      { source: 'x', rows: [{ ...importRow('one'), playStyle: 'Unknown' }] },
      { source: 'x', rows: [{ ...importRow('one'), attendance: 'ready' }] },
      { source: 'x', rows: [{ name: 'No ID', skillLevel: 'intermediate', skillRating: 3, playStyle: 'Balanced' }] },
    ];
    const before = repository.getSnapshot();
    const auditBefore = repository.getAuditEntriesForTests();
    for (const operation of ['preview', 'import']) {
      for (const payload of invalidPayloads) {
        const response = await app.inject({
          method: 'POST', url: `/api/roster/${operation}`, headers: authHeaders, payload: payload as object,
        });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect((await app.inject({
        method: 'POST', url: `/api/roster/${operation}`,
        headers: { ...authHeaders, 'content-type': 'application/json' }, payload: '{bad json',
      })).statusCode).toBe(400);
    }
    for (const payload of [{}, { attendance: 'playing' }, { attendance: 'ready', extra: true }]) {
      expect((await app.inject({
        method: 'POST', url: `/api/players/${id}/attendance`, headers: authHeaders, payload,
      })).statusCode).toBe(400);
    }
    expect((await attendance(app, 'not-an-id', 'ready')).statusCode).toBe(400);
    expect((await attendance(app, '00000000-0000-4000-8000-000000000000', 'ready')).statusCode).toBe(404);
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(auditBefore);
  });

  it('accepts the documented row and field boundaries', async () => {
    const { app, repository } = await makeApp();
    const rows = Array.from({ length: 200 }, (_, index) => {
      const prefix = String(index);
      return {
        ...importRow(prefix + '界'.repeat(100 - prefix.length), '界'.repeat(80)),
        skillRating: index === 0 ? 1 : 6,
      };
    });
    const source = '界'.repeat(80);
    expect(Buffer.byteLength(JSON.stringify({ source, rows }), 'utf8')).toBeGreaterThan(testConfig().bodyLimit);
    expect((await rosterRequest(app, 'preview', rows, source)).statusCode).toBe(200);
    const response = await rosterRequest(app, 'import', rows, source);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ added: number }>().added).toBe(200);
    expect(repository.getSnapshot().roster).toHaveLength(200);
    expect(repository.getSnapshot().holdingPool).toHaveLength(0);
  });

  it('migrates a temporary v1 database without losing entities and persists import attendance', () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'pickleball-roster-test-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'synthetic.sqlite');
    const initial = new Repository(databasePath);
    openRepositories.push(initial);
    for (const name of ['Legacy one', 'Legacy two', 'Legacy three', 'Legacy four', 'Legacy five', 'Legacy six', 'Legacy seven', 'Legacy eight']) {
      initial.createPlayer({ name, skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced' });
    }
    const ids = initial.getSnapshot().holdingPool.map((player) => player.id);
    for (const id of ids.slice(0, 4)) initial.movePlayer(id, { type: 'court', courtId: 1 });
    initial.startGame(1);
    initial.endGame(1);
    for (const id of ids.slice(0, 4)) initial.movePlayer(id, { type: 'court', courtId: 1 });
    initial.startGame(1);
    initial.toggleCourtStatus(6);
    initial.persistProposal({ source: 'rules-fallback', playerIds: ids.slice(4, 8), notice: 'Synthetic migration fixture.' });
    const before = initial.getSnapshot();
    const auditBefore = initial.getAuditEntriesForTests();
    initial.close();

    const legacyDatabase = new Database(databasePath);
    legacyDatabase.pragma('foreign_keys = OFF');
    legacyDatabase.exec(`
      ALTER TABLE game_history DROP COLUMN status;
      ALTER TABLE game_history DROP COLUMN reason;
      ALTER TABLE game_history DROP COLUMN corrected_at;
      ALTER TABLE game_history DROP COLUMN court_name;
      ALTER TABLE players DROP COLUMN waiting_since;
      DROP INDEX idx_game_history_session;
      ALTER TABLE game_history DROP COLUMN player_ids_json;
      ALTER TABLE game_history DROP COLUMN session_id;
      DROP TABLE rotation_plans;
      DROP TABLE session_players;
      DROP TABLE club_settings;
      DROP TABLE sessions;
      DROP INDEX idx_players_import_identity;
      ALTER TABLE players DROP COLUMN external_id;
      ALTER TABLE players DROP COLUMN source;
      ALTER TABLE players DROP COLUMN attendance;
      PRAGMA user_version = 1;
    `);
    legacyDatabase.close();

    const upgraded = new Repository(databasePath);
    openRepositories.push(upgraded);
    expect(upgraded.getSchemaVersion()).toBe(6);
    const after = upgraded.getSnapshot();
    // Genuine v1 history stored names only; migration cannot invent identity/counts.
    const withoutStats = (players: AppSnapshot['roster']) => players.map((player) => ({
      ...player, gamesPlayed: undefined, playedSeconds: undefined, waitingSince: undefined,
    }));
    expect(withoutStats(after.roster)).toEqual(withoutStats(before.roster));
    expect(after.roster.every((player) => player.gamesPlayed === 0 && player.playedSeconds === 0)).toBe(true);
    expect(withoutStats(after.holdingPool)).toEqual(withoutStats(before.holdingPool));
    expect(after.nextGamePool).toEqual(before.nextGamePool);
    const legacyCourts = (snapshot: AppSnapshot) => snapshot.courts.map((court) => ({
      ...court, timeElapsed: 0, players: withoutStats(court.players),
    }));
    expect(legacyCourts(after)).toEqual(legacyCourts(before));
    const legacyGames = (snapshot: AppSnapshot) => snapshot.gameHistory.map((game) => ({
      ...game, sessionId: undefined, playerIds: undefined,
    }));
    expect(legacyGames(after)).toEqual(legacyGames(before));
    expect(after.gameHistory.every((game) => game.playerIds.length === 0)).toBe(true);
    // Reviews prepared under the former policy expire at migration; no stale approval.
    expect(after.matchProposals).toHaveLength(0);
    expect(upgraded.getAuditEntriesForTests()).toEqual(auditBefore);
    const imported = upgraded.importRoster(' Persistent SOURCE ', [importRow('PersistedID')]);
    const importedId = imported.snapshot.roster.find((player) => player.externalId === 'PersistedID')!.id;
    upgraded.setAttendance(importedId, 'ready');
    upgraded.setAttendance(importedId, 'resting');
    upgraded.close();

    const reopened = new Repository(databasePath);
    openRepositories.push(reopened);
    const persisted = reopened.getSnapshot();
    expect(persisted.roster.find((player) => player.id === importedId)).toMatchObject({
      source: 'persistent source', externalId: 'PersistedID', attendance: 'resting',
    });
    expect(persisted.holdingPool.some((player) => player.id === importedId)).toBe(false);
    expect(reopened.importRoster('PERSISTENT SOURCE', [importRow('PersistedID')])).toMatchObject({ added: 0, skipped: 1 });
    expect(reopened.setAttendance(importedId, 'ready').holdingPool.at(-1)!.id).toBe(importedId);
  });
});
