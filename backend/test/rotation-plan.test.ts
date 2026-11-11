import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import type { AppSnapshot, RotationPlan, SkillLevel } from '../src/models.js';

const ACCESS_KEY = 'rotation-plan-test-key-123456';
const auth = { authorization: `Bearer ${ACCESS_KEY}` };
const apps: FastifyInstance[] = [];
const repositories: Repository[] = [];
const directories: string[] = [];
const config: AppConfig = {
  host: '127.0.0.1',
  port: 3001,
  operatorAccessKey: ACCESS_KEY,
  corsOrigins: ['http://localhost:5173'],
  databasePath: ':memory:',
  bodyLimit: 65_536,
  rateLimitMax: 10_000,
  rateLimitWindow: '1 minute',
  demoSeed: false,
};

async function open(databasePath = ':memory:') {
  const repository = new Repository(databasePath);
  const app = await buildApp({ repository, config: { ...config, databasePath } });
  repositories.push(repository);
  apps.push(app);
  return { app, repository };
}

function addPlayers(
  repository: Repository,
  count: number,
  skillLevel: SkillLevel = 'intermediate',
  rating: number | null = 3.5,
): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const before = new Set(repository.getSnapshot().roster.map((player) => player.id));
    const snapshot = repository.createPlayer({
      name: `${skillLevel} player ${repository.getSnapshot().roster.length + 1}`,
      skillLevel,
      skillRating: rating,
      playStyle: 'Balanced',
    });
    ids.push(snapshot.roster.find((player) => !before.has(player.id))!.id);
  }
  return ids;
}

async function createPlan(app: FastifyInstance, allowMixed = false): Promise<RotationPlan> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/rotation-plans',
    headers: auth,
    payload: { allowMixed },
  });
  expect(response.statusCode).toBe(201);
  return response.json<RotationPlan>();
}

async function applyPlan(app: FastifyInstance, id: string, approveMixed = false) {
  return app.inject({
    method: 'POST',
    url: `/api/rotation-plans/${id}/apply`,
    headers: auth,
    payload: { approveMixed },
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  repositories.splice(0).forEach((repository) => repository.close());
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true }));
});

describe('persisted multi-court rotation plans', () => {
  it('dismisses a pending review without moving players and makes retries audit-neutral', async () => {
    const { app, repository } = await open();
    addPlayers(repository, 8);
    const plan = await createPlan(app);
    const before = repository.getSnapshot();
    const revision = repository.getMatchContext().revision;
    const reject = () => app.inject({ method: 'POST', url: `/api/rotation-plans/${plan.id}/reject`, headers: auth });
    const dismissed = await reject();
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toEqual({ id: plan.id, status: 'rejected' });
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getMatchContext().revision).toBe(revision);
    expect(repository.getCurrentRotationPlan()).toBeNull();
    const audit = repository.getAuditEntriesForTests();
    expect(audit.filter(entry => entry.action === 'rotation_plan.rejected')).toHaveLength(1);
    expect((await reject()).json()).toEqual(dismissed.json());
    expect(repository.getAuditEntriesForTests()).toEqual(audit);
    expect((await applyPlan(app, plan.id)).statusCode).toBe(409);
    expect(repository.getSnapshot()).toEqual(before);
  });

  it('does not let dismissal undo an applied rotation', async () => {
    const { app, repository } = await open();
    addPlayers(repository, 8);
    const plan = await createPlan(app);
    expect((await applyPlan(app, plan.id)).statusCode).toBe(200);
    const before = repository.getSnapshot(), audit = repository.getAuditEntriesForTests();
    const response = await app.inject({ method: 'POST', url: `/api/rotation-plans/${plan.id}/reject`, headers: auth });
    expect(response.statusCode).toBe(409);
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(audit);
  });

  it('reviews the queue-first cohort across empty courts and applies every group atomically', async () => {
    const { app, repository } = await open();
    repository.updateSettings({
      ...repository.getSettings(),
      courtCount: 3,
      courtNames: ['North', 'South', 'East'],
    });
    const queue = addPlayers(repository, 16);

    const plan = await createPlan(app);
    const assignedIds = plan.assignments.flatMap((assignment) => assignment.players.map((player) => player.id));
    expect(plan).toMatchObject({
      sessionId: repository.getSnapshot().session.id,
      status: 'pending',
      allowMixed: false,
      canMix: false,
      policy: { rotationMode: 'open', avoidRepeatPartners: true },
      blockedReason: null,
    });
    expect(plan.assignments.map((assignment) => assignment.courtName)).toEqual(['North', 'South', 'East']);
    expect(assignedIds).toHaveLength(12);
    expect(new Set(assignedIds).size).toBe(12);
    expect(new Set(assignedIds)).toEqual(new Set(queue.slice(0, 12)));
    expect(plan.waiting.map((player) => player.id)).toEqual(queue.slice(12));
    expect(repository.getSnapshot().courts.every((court) => court.players.length === 0)).toBe(true);

    const response = await applyPlan(app, plan.id);
    expect(response.statusCode).toBe(200);
    const applied = response.json<AppSnapshot>();
    expect(applied.courts.map((court) => court.players.length)).toEqual([4, 4, 4]);
    expect(applied.courts.every((court) => court.status === 'available'
      && court.gameStartedAt === null)).toBe(true);
    expect(applied.holdingPool.map((player) => player.id)).toEqual(queue.slice(12));
    expect(applied.gameHistory).toEqual([]);
    expect(repository.getCurrentRotationPlan()).toBeNull();

    const audits = repository.getAuditEntriesForTests();
    const revision = repository.getMatchContext().revision;
    const retry = await applyPlan(app, plan.id);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<AppSnapshot>()).toEqual(applied);
    expect(repository.getMatchContext().revision).toBe(revision);
    expect(repository.getAuditEntriesForTests()).toEqual(audits);
  });

  it('rejects the whole stale plan after any board change without partially moving its groups', async () => {
    const { app, repository } = await open();
    repository.updateSettings({
      ...repository.getSettings(),
      courtCount: 3,
      courtNames: ['Court 1', 'Court 2', 'Court 3'],
    });
    const queue = addPlayers(repository, 13);
    const plan = await createPlan(app);
    expect(plan.assignments).toHaveLength(3);

    repository.movePlayer(queue[12]!, { type: 'court', courtId: 3 });
    const before = repository.getSnapshot();
    const auditsBefore = repository.getAuditEntriesForTests();
    const response = await applyPlan(app, plan.id);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
    expect(repository.getSnapshot()).toEqual(before);
    expect(repository.getAuditEntriesForTests()).toEqual(auditsBefore);
    expect(repository.getSnapshot().courts[0]!.players).toEqual([]);
    expect(repository.getSnapshot().courts[1]!.players).toEqual([]);
    expect(repository.getSnapshot().courts[2]!.players.map((player) => player.id)).toEqual([queue[12]]);
  });

  it('keeps an incomplete oldest skill band waiting until mixed play is previewed and approved', async () => {
    const { app, repository } = await open();
    repository.updateSettings({
      ...repository.getSettings(),
      courtCount: 2,
      courtNames: ['Court 1', 'Court 2'],
      rotationMode: 'skill-banded',
    });
    const oldest = addPlayers(repository, 1, 'beginner', 2);
    addPlayers(repository, 3, 'intermediate', 3.5);
    addPlayers(repository, 4, 'advanced', 4.5);

    const blocked = await createPlan(app);
    expect(blocked.assignments).toEqual([]);
    expect(blocked.waiting).toHaveLength(8);
    expect(blocked.canMix).toBe(true);
    expect(blocked.blockedReason).toContain('beginner');

    const mixed = await createPlan(app, true);
    expect(mixed.assignments).toHaveLength(2);
    expect(mixed.assignments[0]!.players.map((player) => player.id)).toContain(oldest[0]);
    expect(mixed.assignments[0]!.mixed).toBe(true);
    expect(mixed.canMix).toBe(true);
    const before = repository.getSnapshot();

    const denied = await applyPlan(app, mixed.id);
    expect(denied.statusCode).toBe(409);
    expect(repository.getSnapshot()).toEqual(before);
    const approved = await applyPlan(app, mixed.id, true);
    expect(approved.statusCode).toBe(200);
    expect(approved.json<AppSnapshot>().courts.map((court) => court.players.length)).toEqual([4, 4]);
  });

  it('preserves the oldest full skill-band group even when its members are interleaved', async () => {
    const { app, repository } = await open();
    repository.updateSettings({
      ...repository.getSettings(),
      courtCount: 1,
      courtNames: ['North'],
      rotationMode: 'skill-banded',
    });
    const oldest = addPlayers(repository, 1, 'beginner', 2);
    const olderIntermediate = addPlayers(repository, 3, 'intermediate', 3.5);
    const laterBeginner = addPlayers(repository, 3, 'beginner', 2.5);

    const strict = await createPlan(app);
    expect(strict.canMix).toBe(false);
    expect(strict.assignments[0]!.players.map((player) => player.id))
      .toEqual([...oldest, ...laterBeginner]);
    expect(strict.waiting.map((player) => player.id)).toEqual(olderIntermediate);
  });

  it('persists pending reviews across a reopen without changing their selected players', async () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'rotation-plan-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'board.sqlite');
    const first = await open(databasePath);
    addPlayers(first.repository, 8);
    const planned = first.repository.createRotationPlan();
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    first.repository.close();
    repositories.splice(repositories.indexOf(first.repository), 1);

    const second = await open(databasePath);
    expect(second.repository.getSchemaVersion()).toBe(6);
    expect(second.repository.getCurrentRotationPlan()).toEqual(planned);
  });

  it('uses completed team history to avoid immediately repeating both prior partnerships', async () => {
    const { repository } = await open();
    repository.updateSettings({
      ...repository.getSettings(),
      courtCount: 1,
      courtNames: ['North'],
    });
    const players = addPlayers(repository, 4);
    players.forEach((playerId) => repository.movePlayer(playerId, { type: 'court', courtId: 1 }));
    repository.startGame(1);
    repository.endGame(1);

    const plan = repository.createRotationPlan();
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]!.metrics.repeatPartners).toBe(0);
    const pair = (ids: string[]) => [...ids].sort().join('|');
    const teams = [
      pair(plan.assignments[0]!.players.slice(0, 2).map((player) => player.id)),
      pair(plan.assignments[0]!.players.slice(2).map((player) => player.id)),
    ];
    expect(teams).not.toContain(pair(players.slice(0, 2)));
    expect(teams).not.toContain(pair(players.slice(2)));
  });

  it('keeps six-court planning bounded while preserving the first 24 of 48 queued players', async () => {
    const { repository } = await open();
    const queue = addPlayers(repository, 48, 'intermediate', null);

    const startedAt = performance.now();
    const first = repository.createRotationPlan();
    const elapsed = performance.now() - startedAt;
    const second = repository.createRotationPlan();
    const assignmentIds = first.assignments.flatMap((assignment) =>
      assignment.players.map((player) => player.id));

    expect(first.assignments).toHaveLength(6);
    expect(assignmentIds).toHaveLength(24);
    expect(new Set(assignmentIds)).toEqual(new Set(queue.slice(0, 24)));
    expect(first.waiting.map((player) => player.id)).toEqual(queue.slice(24));
    expect(first.assignments.every((assignment) => assignment.metrics.ratingDifference === null)).toBe(true);
    expect(second.assignments.map((assignment) => assignment.players.map((player) => player.id)))
      .toEqual(first.assignments.map((assignment) => assignment.players.map((player) => player.id)));
    expect(elapsed).toBeLessThan(2_000);
  });
});
