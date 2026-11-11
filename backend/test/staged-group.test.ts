import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import type { AppSnapshot, MatchProposal, QueueLane, SkillLevel } from '../src/models.js';

const key = 'staged-group-test-operator-key';
const headers = (accessKey = key) => ({ authorization: `Bearer ${accessKey}` });
const apps: FastifyInstance[] = [];
const directories: string[] = [];
const config: AppConfig = {
  host: '127.0.0.1', port: 3001, operatorAccessKey: key,
  corsOrigins: ['http://localhost:5173'], databasePath: ':memory:',
  bodyLimit: 65_536, rateLimitMax: 10_000, rateLimitWindow: '1 minute', demoSeed: false,
};

async function open(options: {
  config?: Partial<AppConfig>; databasePath?: string;
} = {}) {
  const repository = new Repository(options.databasePath ?? ':memory:');
  const app = await buildApp({ repository, config: { ...config, ...options.config } });
  apps.push(app);
  return { app, repository };
}
async function post(app: FastifyInstance, url: string, payload?: unknown, accessKey = key) {
  return app.inject({ method: 'POST', url, headers: headers(accessKey),
    ...(payload === undefined ? {} : { payload }) });
}
async function state(app: FastifyInstance, accessKey = key) {
  const response = await app.inject({ method: 'GET', url: '/api/state', headers: headers(accessKey) });
  expect(response.statusCode).toBe(200);
  return response.json<AppSnapshot>();
}
function add(repository: Repository, count = 4, skillLevel: SkillLevel = 'intermediate', rating: number | null = 3.5) {
  return Array.from({ length: count }, (_, index) => repository.createPlayer({
    name: `${skillLevel} player ${repository.getSnapshot().roster.length + index + 1}`,
    skillLevel, skillRating: rating, playStyle: 'Balanced',
  }).holdingPool.at(-1)!.id);
}
function stage(repository: Repository, ids: string[], lane: QueueLane = 'intermediate') {
  ids.forEach((id) => repository.movePlayer(id, { type: 'next-game-pool', lane }));
  return { sessionId: repository.getSnapshot().session.id, lane, playerIds: ids };
}
const assignmentAudits = (repository: Repository) => repository.getAuditEntriesForTests()
  .filter((entry) => entry.action === 'staged_group.assigned');
async function assertRejectedUnchanged(
  app: FastifyInstance, repository: Repository, payload: unknown, expectedStatus: number, courtId = 1,
) {
  const before = repository.getSnapshot();
  const audits = repository.getAuditEntriesForTests();
  const report = repository.getSessionReport(before.session.id);
  const response = await post(app, `/api/courts/${courtId}/assign-staged`, payload);
  expect(response.statusCode).toBe(expectedStatus);
  expect(repository.getSnapshot()).toEqual(before);
  expect(repository.getAuditEntriesForTests()).toEqual(audits);
  expect(repository.getSessionReport(before.session.id)).toEqual(report);
  return response;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true }));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('atomic staged group assignment', () => {
  it('stages a pending API proposal, assigns its reviewed order, and retains later groups and other lanes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const { app, repository } = await open();
    add(repository, 8);
    const reviews: MatchProposal[] = [];
    for (let index = 0; index < 2; index += 1) {
      const reviewResponse = await post(app, '/api/match-proposals', {});
      expect(reviewResponse.statusCode).toBe(201);
      const review = reviewResponse.json<MatchProposal>();
      expect(review.status).toBe('pending');
      expect(repository.getSnapshot().holdingPool).toHaveLength(8 - index * 4);
      expect(repository.getSnapshot().courts[0]!.players).toEqual([]);
      reviews.push(review);
      const staged = await post(app, `/api/match-proposals/${review.id}/apply`, {});
      expect(staged.statusCode).toBe(200);
      expect(staged.json<AppSnapshot>().nextGamePool.intermediate.map((player) => player.id))
        .toEqual(reviews.flatMap((proposal) => proposal.playerIds));
    }
    const otherLane = add(repository, 2, 'beginner', 2);
    stage(repository, otherLane, 'beginner');
    const before = repository.getSnapshot();
    const reportBefore = repository.getSessionReport(before.session.id);
    const providerCalls = fetcher.mock.calls.length;
    const individualMove = vi.spyOn(repository, 'movePlayer');
    const response = await post(app, '/api/courts/2/assign-staged', {
      sessionId: before.session.id, lane: 'intermediate', playerIds: reviews[0]!.playerIds,
    });
    expect(response.statusCode).toBe(200);
    const assigned = response.json<AppSnapshot>();
    expect(assigned.courts[1]!.players.map((player) => player.id)).toEqual(reviews[0]!.playerIds);
    expect(assigned.courts[1]).toMatchObject({ status: 'available', gameStartedAt: null, timeElapsed: 0 });
    expect(assigned.nextGamePool.intermediate.map((player) => player.id)).toEqual(reviews[1]!.playerIds);
    expect(assigned.nextGamePool.intermediate.map((player) => player.location)).toEqual(
      reviews[1]!.playerIds.map((_, index) => ({ type: 'next-game-pool', lane: 'intermediate', index })),
    );
    expect(assigned.nextGamePool.beginner).toEqual(before.nextGamePool.beginner);
    expect(assigned.gameHistory).toEqual([]);
    expect(assigned.roster.every((player) => player.gamesPlayed === 0 && player.playedSeconds === 0)).toBe(true);
    expect(repository.getSessionReport(before.session.id)).toEqual(reportBefore);
    expect(individualMove).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(providerCalls);
    expect(repository.getSchemaVersion()).toBe(6);
    expect(assignmentAudits(repository)).toHaveLength(1);
    expect(assignmentAudits(repository)[0]).toMatchObject({ entity_type: 'court', entity_id: '2' });
    expect(JSON.parse(String(assignmentAudits(repository)[0]!.metadata_json))).toEqual({
      sessionId: before.session.id, courtId: 2, lane: 'intermediate', playerIds: reviews[0]!.playerIds, approveMixed: false,
    });
  });

  it.each(['doubles', 'singles'] as const)('assigns a manually staged %s group in its lane order', async (gameMode) => {
    const { app, repository } = await open();
    repository.updateSettings({ ...repository.getSettings(), gameMode });
    const ids = add(repository, gameMode === 'doubles' ? 5 : 3);
    const ordered = [...ids].reverse();
    stage(repository, ordered);
    const size = gameMode === 'doubles' ? 4 : 2;
    const payload = { sessionId: repository.getSnapshot().session.id, lane: 'intermediate', playerIds: ordered.slice(0, size) };
    const response = await post(app, '/api/courts/1/assign-staged', payload);
    expect(response.statusCode).toBe(200);
    expect(response.json<AppSnapshot>().courts[0]!.players.map((player) => player.id)).toEqual(payload.playerIds);
    expect(response.json<AppSnapshot>().nextGamePool.intermediate.map((player) => player.id)).toEqual(ordered.slice(size));
    expect(response.json<AppSnapshot>().courts[0]!.players.slice(0, size / 2).map((player) => player.id))
      .toEqual(payload.playerIds.slice(0, size / 2));
    expect(repository.getSnapshot().gameHistory).toEqual([]);
  });

  it('retries the identical assignment once without duplicate audit entries or rotation changes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { app, repository } = await open();
    const payload = stage(repository, add(repository));
    const requests = await Promise.all([post(app, '/api/courts/1/assign-staged', payload),
      post(app, '/api/courts/1/assign-staged', payload)]);
    expect(requests.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(requests[0]!.json()).toEqual(requests[1]!.json());
    expect(assignmentAudits(repository)).toHaveLength(1);
    const revision = repository.getMatchContext().revision;
    const beforeAudits = repository.getAuditEntriesForTests();
    expect((await post(app, '/api/courts/1/assign-staged', payload)).statusCode).toBe(200);
    expect(repository.getMatchContext().revision).toBe(revision);
    expect(repository.getAuditEntriesForTests()).toEqual(beforeAudits);
    await assertRejectedUnchanged(app, repository, { ...payload, playerIds: [...payload.playerIds].reverse() }, 409);
    await assertRejectedUnchanged(app, repository, { ...payload, lane: 'mixed' }, 409);
    await assertRejectedUnchanged(app, repository, { ...payload, approveMixed: true }, 409);
  });

  it('allows only one of concurrent requests for different courts to claim the same group', async () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'staged-group-concurrent-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'board.sqlite');
    const first = await open({ databasePath });
    const second = await open({ databasePath });
    const payload = stage(first.repository, add(first.repository));
    const responses = await Promise.all([post(first.app, '/api/courts/1/assign-staged', payload),
      post(second.app, '/api/courts/2/assign-staged', payload)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const snapshot = first.repository.getSnapshot();
    const occupied = snapshot.courts.filter((court) => court.players.length > 0);
    expect(occupied).toHaveLength(1);
    expect(occupied[0]!.players.map((player) => player.id)).toEqual(payload.playerIds);
    expect(snapshot.nextGamePool.intermediate).toEqual([]);
    expect(assignmentAudits(first.repository)).toHaveLength(1);
    expect(snapshot.gameHistory).toEqual([]);
  });

  it('rolls back every player update, positions, ledger and audit after a database failure mid-assignment', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'staged-group-rollback-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'board.sqlite');
    const { app, repository } = await open({ databasePath });
    const ids = add(repository, 6);
    stage(repository, ids);
    const connection = new Database(databasePath);
    connection.exec(`CREATE TRIGGER fail_staged_assignment BEFORE UPDATE OF location_type ON players
      WHEN NEW.location_type = 'court' AND NEW.id = '${ids[2]}'
      BEGIN SELECT RAISE(ABORT, 'simulated assignment failure'); END`);
    connection.close();
    await assertRejectedUnchanged(app, repository, {
      sessionId: repository.getSnapshot().session.id, lane: 'intermediate', playerIds: ids.slice(0, 4),
    }, 500);
    expect(assignmentAudits(repository)).toEqual([]);
  });
});

describe('staged assignment conflicts and validation', () => {
  it.each(['reordered', 'later group', 'wrong lane', 'unknown player', 'wrong session'] as const)(
    'rejects a %s expectation without moving anyone', async (reason) => {
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
      const { app, repository } = await open();
      const ids = add(repository, 8);
      stage(repository, ids);
      const payload = { sessionId: repository.getSnapshot().session.id, lane: 'intermediate', playerIds: ids.slice(0, 4) };
      if (reason === 'reordered') payload.playerIds.reverse();
      if (reason === 'later group') payload.playerIds = ids.slice(4);
      if (reason === 'wrong lane') payload.lane = 'advanced';
      if (reason === 'unknown player') payload.playerIds[2] = randomUUID();
      if (reason === 'wrong session') payload.sessionId = randomUUID();
      await assertRejectedUnchanged(app, repository, payload, 409);
    },
  );

  it.each(['removed', 'resting', 'moved lane', 'lane order changed'] as const)(
    'rejects stale players after a staged player is %s', async (change) => {
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
      const { app, repository } = await open();
      const ids = add(repository, 5);
      stage(repository, ids);
      const payload = { sessionId: repository.getSnapshot().session.id, lane: 'intermediate', playerIds: ids.slice(0, 4) };
      if (change === 'removed') repository.removePlayer(ids[2]!);
      if (change === 'resting') repository.setAttendance(ids[2]!, 'resting');
      if (change === 'moved lane') repository.movePlayer(ids[2]!, { type: 'next-game-pool', lane: 'mixed' });
      if (change === 'lane order changed') {
        repository.movePlayer(ids[0]!, { type: 'holding-pool' });
        repository.movePlayer(ids[0]!, { type: 'next-game-pool', lane: 'intermediate' });
      }
      await assertRejectedUnchanged(app, repository, payload, 409);
    },
  );

  it.each(['disabled', 'occupied', 'in-play', 'hidden'] as const)('rejects a %s court', async (courtState) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { app, repository } = await open();
    const payload = stage(repository, add(repository));
    if (courtState === 'disabled') repository.toggleCourtStatus(1);
    if (courtState === 'occupied' || courtState === 'in-play') {
      const courtPlayers = add(repository, courtState === 'in-play' ? 4 : 1);
      courtPlayers.forEach((id) => repository.movePlayer(id, { type: 'court', courtId: 1 }));
      if (courtState === 'in-play') repository.startGame(1);
    }
    if (courtState === 'hidden') repository.updateSettings({ ...repository.getSettings(), courtCount: 1, courtNames: ['North'] });
    await assertRejectedUnchanged(app, repository, payload, courtState === 'hidden' ? 404 : 409, courtState === 'hidden' ? 2 : 1);
  });

  it('rejects a changed game size, a closed session, and the previous session after restart', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { app, repository } = await open();
    const payload = stage(repository, add(repository));
    repository.updateSettings({ ...repository.getSettings(), gameMode: 'singles' });
    await assertRejectedUnchanged(app, repository, payload, 400);
    repository.updateSettings({ ...repository.getSettings(), gameMode: 'doubles' });
    repository.closeSession();
    const archive = repository.getSessionReport(payload.sessionId);
    await assertRejectedUnchanged(app, repository, payload, 409);
    repository.startSession('Replacement session', true);
    payload.playerIds.forEach((id) => repository.setAttendance(id, 'ready'));
    stage(repository, payload.playerIds);
    await assertRejectedUnchanged(app, repository, payload, 409);
    expect(repository.getSessionReport(payload.sessionId)).toEqual(archive);
  });

  it('requires fresh mixed-level approval under skill-banded rules and preserves unknown ratings', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { app, repository } = await open();
    const ids = [...add(repository, 1, 'unrated', null), ...add(repository, 3, 'advanced', 4.5)];
    const payload = stage(repository, ids, 'mixed');
    repository.updateSettings({ ...repository.getSettings(), rotationMode: 'skill-banded' });
    await assertRejectedUnchanged(app, repository, payload, 409);
    const response = await post(app, '/api/courts/1/assign-staged', { ...payload, approveMixed: true });
    expect(response.statusCode).toBe(200);
    expect(response.json<AppSnapshot>().courts[0]!.players[0]).toMatchObject({ id: ids[0], skillLevel: 'unrated', skillRating: null });
    expect(response.json<AppSnapshot>().courts[0]!.players.map((player) => player.id)).toEqual(ids);
  });

  it('accepts a single unrated band without treating null ratings as mixed levels', async () => {
    const { app, repository } = await open();
    repository.updateSettings({ ...repository.getSettings(), rotationMode: 'skill-banded' });
    const payload = stage(repository, add(repository, 4, 'unrated', null), 'mixed');
    const response = await post(app, '/api/courts/1/assign-staged', payload);
    expect(response.statusCode).toBe(200);
    expect(response.json<AppSnapshot>().courts[0]!.players.every((player) => player.skillRating === null && player.skillLevel === 'unrated')).toBe(true);
  });

  it('rejects malformed or expanded request bodies before making changes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { app, repository } = await open();
    const payload = stage(repository, add(repository));
    const invalidBodies: unknown[] = [undefined, null, [], {}, { ...payload, sessionId: 'not-a-uuid' },
      { ...payload, lane: 'unrated' }, { ...payload, playerIds: 'not-an-array' },
      { ...payload, playerIds: ['not-a-uuid', ...payload.playerIds.slice(1)] },
      { ...payload, playerIds: [payload.playerIds[0], payload.playerIds[0], ...payload.playerIds.slice(2)] },
      { ...payload, playerIds: payload.playerIds.slice(0, 3) }, { ...payload, playerIds: payload.playerIds.slice(0, 1) },
      { ...payload, playerIds: [...payload.playerIds, randomUUID()] }, { ...payload, approveMixed: 'true' },
      { ...payload, courtId: 2 }, { ...payload, proposalId: randomUUID() }];
    for (const invalid of invalidBodies) await assertRejectedUnchanged(app, repository, invalid, 400);
    await assertRejectedUnchanged(app, repository, payload, 400, 17);
    await assertRejectedUnchanged(app, repository, payload, 400, 0);
    expect(assignmentAudits(repository)).toEqual([]);
  });
});

describe('staged assignment access boundaries', () => {
  it('rejects anonymous, incorrect, and display credentials and retains standard rate limits', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { app, repository } = await open();
    const payload = stage(repository, add(repository));
    const grant = await post(app, '/api/display-access');
    const displayKey = grant.json<{ accessKey: string }>().accessKey;
    const before = repository.getSnapshot();
    expect((await app.inject({ method: 'POST', url: '/api/courts/1/assign-staged', payload })).statusCode).toBe(401);
    expect((await post(app, '/api/courts/1/assign-staged', payload, 'wrong-operator-key')).statusCode).toBe(401);
    expect((await post(app, '/api/courts/1/assign-staged', payload, displayKey)).statusCode).toBe(401);
    expect(repository.getSnapshot()).toEqual(before);
    expect(assignmentAudits(repository)).toEqual([]);
    const limited = await open({ config: { rateLimitMax: 1 } });
    const limitedPayload = stage(limited.repository, add(limited.repository));
    expect((await post(limited.app, '/api/courts/1/assign-staged', limitedPayload)).statusCode).toBe(200);
    expect((await post(limited.app, '/api/courts/1/assign-staged', limitedPayload)).statusCode).toBe(429);
    expect(assignmentAudits(limited.repository)).toHaveLength(1);
  });

  it('keeps public visitor boards and the private repository isolated during cross-visitor requests', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { app, repository } = await open({ config: { publicDemo: true } });
    const first = (await app.inject({ method: 'POST', url: '/api/visitor-sessions' })).json<{ accessKey: string }>();
    const second = (await app.inject({ method: 'POST', url: '/api/visitor-sessions' })).json<{ accessKey: string }>();
    const own = await state(app, first.accessKey);
    const ids = own.nextGamePool.intermediate.map((player) => player.id);
    const payload = { sessionId: own.session.id, lane: 'intermediate', playerIds: ids };
    const firstBefore = await state(app, first.accessKey);
    const secondBefore = await state(app, second.accessKey);
    expect((await post(app, '/api/courts/11/assign-staged', payload, second.accessKey)).statusCode).toBe(409);
    expect((await post(app, '/api/courts/11/assign-staged', { ...payload, sessionId: secondBefore.session.id }, second.accessKey)).statusCode).toBe(409);
    expect(await state(app, first.accessKey)).toEqual(firstBefore);
    expect(await state(app, second.accessKey)).toEqual(secondBefore);
    const assigned = await post(app, '/api/courts/11/assign-staged', payload, first.accessKey);
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json<AppSnapshot>().courts[10]!.players.map((player) => player.id)).toEqual(ids);
    expect(await state(app, second.accessKey)).toEqual(secondBefore);
    expect(repository.getSnapshot().roster).toEqual([]);
    expect(assignmentAudits(repository)).toEqual([]);
    expect((await post(app, '/api/courts/11/assign-staged', payload, key)).statusCode).toBe(401);
  });
});
