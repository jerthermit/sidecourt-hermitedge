import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import type { AppSnapshot, ClubSettings, MatchProposal, SkillLevel } from '../src/models.js';

const key = 'fictional-showcase-check-operator';
const headers = { authorization: `Bearer ${key}` };
const apps: FastifyInstance[] = [];
const config: AppConfig = {
  host: '127.0.0.1', port: 3001, operatorAccessKey: key,
  corsOrigins: ['http://localhost:5173'], databasePath: ':memory:',
  bodyLimit: 65_536, rateLimitMax: 100_000, rateLimitWindow: '1 minute', demoSeed: false,
};
async function open() {
  const repository = new Repository(':memory:');
  const app = await buildApp({ repository, config });
  apps.push(app);
  return { app, repository };
}
async function post(app: FastifyInstance, url: string, payload?: unknown, auth = headers) {
  return app.inject({ method: 'POST', url, headers: auth, ...(payload === undefined ? {} : { payload }) });
}
async function state(app: FastifyInstance): Promise<AppSnapshot> {
  const response = await app.inject({ method: 'GET', url: '/api/state', headers });
  expect(response.statusCode).toBe(200);
  return response.json<AppSnapshot>();
}
async function configure(app: FastifyInstance, changes: Partial<ClubSettings>) {
  const current = (await state(app)).settings;
  const response = await post(app, '/api/settings', { ...current, ...changes });
  expect(response.statusCode).toBe(200);
  return response.json<AppSnapshot>();
}
async function add(app: FastifyInstance, name: string, skillLevel: SkillLevel = 'intermediate', skillRating: number | null = 3.5) {
  const response = await post(app, '/api/players', { name, skillLevel, skillRating, playStyle: 'Balanced' });
  expect(response.statusCode).toBe(201);
  return response.json<AppSnapshot>().roster.find((player) => player.name === name)!.id;
}
async function propose(app: FastifyInstance, allowMixed = false) {
  const response = await post(app, '/api/match-proposals', { allowMixed });
  expect(response.statusCode).toBe(201);
  return response.json<MatchProposal>();
}
async function complete(app: FastifyInstance, courtId = 1) {
  const proposal = await propose(app);
  expect((await post(app, `/api/match-proposals/${proposal.id}/apply`, { courtId })).statusCode).toBe(200);
  expect((await post(app, `/api/courts/${courtId}/start`)).statusCode).toBe(200);
  expect((await post(app, `/api/courts/${courtId}/end`)).statusCode).toBe(200);
  return proposal;
}
const pairs = (ids: string[]) => [ids.slice(0, 2), ids.slice(2)].map((team) => [...team].sort().join('/')).sort();
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe('five showcase gaps, integrated', () => {
  it('retains genuinely unknown ratings through registration, import, staging, display and CSV', async () => {
    const { app } = await open();
    const registration = await post(app, '/api/players', { name: 'Alex Unrated', playStyle: 'Balanced' });
    expect(registration.statusCode).toBe(201);
    expect(registration.json<AppSnapshot>().roster[0]).toMatchObject({ skillLevel: 'unrated', skillRating: null });
    const rows = [1, 2, 3].map((index) => ({ externalId: `unknown-${index}`, name: `Unrated ${index}`, playStyle: 'Balanced' }));
    const imported = await post(app, '/api/roster/import', { source: 'permitted CSV', rows });
    expect(imported.statusCode).toBe(200);
    for (const player of imported.json<{ snapshot: AppSnapshot }>().snapshot.roster.filter((player) => player.attendance === 'expected')) {
      expect((await post(app, `/api/players/${player.id}/attendance`, { attendance: 'ready' })).statusCode).toBe(200);
    }
    const proposal = await propose(app);
    expect(proposal.targetLane).toBe('mixed');
    expect(proposal.players.every((player) => player.skillRating === null)).toBe(true);
    const applied = await post(app, `/api/match-proposals/${proposal.id}/apply`);
    expect(applied.statusCode).toBe(200);
    expect(applied.json<AppSnapshot>().nextGamePool.mixed).toHaveLength(4);
    const display = (await post(app, '/api/display-access')).json<{ accessKey: string }>();
    const read = await app.inject({ method: 'GET', url: '/api/display', headers: { authorization: `Bearer ${display.accessKey}` } });
    expect(read.statusCode).toBe(200);
    expect(read.json().nextGamePool.mixed).toHaveLength(4);
    expect(read.body).not.toContain('skillRating');
  });

  it('holds the oldest incomplete skill band and requires a separate approval to mix', async () => {
    const { app } = await open();
    await configure(app, { rotationMode: 'skill-banded' });
    const oldest = await add(app, 'First arrival', 'beginner', 2);
    for (let index = 0; index < 4; index += 1) await add(app, `Intermediate ${index}`);
    const waiting = await state(app);
    expect(waiting.rotation).toMatchObject({ needsMixedApproval: true, waitingBand: 'beginner', missingPlayers: 3 });
    const blocked = await post(app, '/api/match-proposals');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('BAND_INCOMPLETE');
    const mixed = await propose(app, true);
    expect(mixed.mixed).toBe(true);
    expect(mixed.playerIds).toContain(oldest);
    expect((await post(app, `/api/match-proposals/${mixed.id}/apply`, { courtId: 1 })).statusCode).toBe(409);
    expect((await state(app)).courts[0]!.players).toHaveLength(0);
    expect((await post(app, `/api/match-proposals/${mixed.id}/apply`, { courtId: 1, approveMixed: true })).statusCode).toBe(200);
  });

  it('uses recorded teammates to vary pairings without displacing FIFO players', async () => {
    const { app } = await open();
    for (const name of ['Jordan', 'Casey', 'Taylor', 'Morgan']) await add(app, name);
    const first = await complete(app);
    const second = await complete(app);
    const third = await complete(app);
    expect([...first.playerIds].sort()).toEqual([...second.playerIds].sort());
    expect(pairs(first.playerIds)).not.toEqual(pairs(second.playerIds));
    expect(pairs(third.playerIds)).not.toEqual(pairs(second.playerIds));
    expect(pairs(third.playerIds)).not.toEqual(pairs(first.playerIds));
    expect((await state(app)).roster.every((player) => player.gamesPlayed === 3)).toBe(true);
  });

  it('tracks the current wait interval, not registration age, through breaks and assignments', async () => {
    const { app } = await open();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const id = await add(app, 'Waiting player');
    expect((await state(app)).roster[0]!.waitingSince).toBe(now);
    now += 120_000;
    await post(app, `/api/players/${id}/attendance`, { attendance: 'resting' });
    expect((await state(app)).roster[0]!.waitingSince).toBeNull();
    now += 60_000;
    await post(app, `/api/players/${id}/attendance`, { attendance: 'ready' });
    expect((await state(app)).roster[0]!.waitingSince).toBe(now);
    await post(app, `/api/players/${id}/move`, { destination: { type: 'court', courtId: 1 } });
    expect((await state(app)).roster[0]!.waitingSince).toBeNull();
    now += 30_000;
    await post(app, `/api/players/${id}/move`, { destination: { type: 'holding-pool' } });
    expect((await state(app)).roster[0]!.waitingSince).toBe(now);
  });

  it('voids an accidental start, corrects actual participants/duration and recalculates counts once', async () => {
    const { app, repository } = await open();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await configure(app, { courtNames: ['North', 'South', 'East', 'West', 'River', 'Park'] });
    const ids: string[] = [];
    for (const name of ['Alex', 'Blair', 'Casey', 'Drew', 'Ellis']) ids.push(await add(app, name));
    const proposal = await propose(app);
    await post(app, `/api/match-proposals/${proposal.id}/apply`, { courtId: 1 });
    await post(app, '/api/courts/1/start');
    now += 30_000;
    const voided = await post(app, '/api/courts/1/void', { reason: 'Accidental start' });
    expect(voided.statusCode).toBe(200);
    expect(voided.json<AppSnapshot>().courts[0]).toMatchObject({ name: 'North', status: 'available', gameStartedAt: null });
    expect(voided.json<AppSnapshot>().courts[0]!.players).toHaveLength(4);
    expect(voided.json<AppSnapshot>().roster.every((player) => player.gamesPlayed === 0)).toBe(true);
    expect(voided.json<AppSnapshot>().gameHistory[0]).toMatchObject({ status: 'voided', reason: 'Accidental start' });
    expect((await post(app, '/api/courts/1/void', { reason: 'Repeated click' })).statusCode).toBe(409);
    await post(app, '/api/courts/1/start');
    now += 45_000;
    const ended = (await post(app, '/api/courts/1/end')).json<AppSnapshot>();
    const game = ended.gameHistory.find((item) => item.status === 'completed')!;
    const replacementIds = [...game.playerIds.slice(0, 3), ids[4]!];
    const correction = { playerIds: replacementIds, durationSeconds: 20, reason: 'Corrected participant and timer' };
    const corrected = await post(app, `/api/games/${game.id}/correct`, correction);
    expect(corrected.statusCode).toBe(200);
    const correctedState = corrected.json<AppSnapshot>();
    expect(correctedState.gameHistory.find((item) => item.id === game.id)).toMatchObject({
      playerIds: replacementIds, duration: 20, status: 'completed', reason: correction.reason, correctedAt: now,
    });
    expect(correctedState.roster.filter((player) => replacementIds.includes(player.id))
      .every((player) => player.gamesPlayed === 1 && player.playedSeconds === 20)).toBe(true);
    expect(correctedState.roster.find((player) => player.id === game.playerIds[3])!.gamesPlayed).toBe(0);
    const auditBefore = repository.getAuditEntriesForTests();
    expect((await post(app, `/api/games/${game.id}/correct`, correction)).statusCode).toBe(200);
    expect(repository.getAuditEntriesForTests()).toEqual(auditBefore);
    expect((await post(app, `/api/games/${game.id}/void`, { reason: 'Match did not finish' })).statusCode).toBe(200);
    const auditVoided = repository.getAuditEntriesForTests();
    expect((await post(app, `/api/games/${game.id}/void`, { reason: 'Repeated void' })).statusCode).toBe(200);
    expect(repository.getAuditEntriesForTests()).toEqual(auditVoided);
    expect((await state(app)).roster.every((player) => player.gamesPlayed === 0 && player.playedSeconds === 0)).toBe(true);
    const exported = await app.inject({ method: 'GET', url: '/api/sessions/export?kind=matches', headers });
    expect(exported.body).toContain('voided');
    expect(exported.body).toContain('Match did not finish');
    expect((await post(app, '/api/sessions/close')).statusCode).toBe(200);
    expect((await post(app, `/api/games/${game.id}/correct`, correction)).statusCode).toBe(409);
  });

  it('saves CSV mapping during a live game without altering court or policy, and rejects duplicate mappings', async () => {
    const { app } = await open();
    for (const name of ['Avery', 'Billie', 'Cameron', 'Dakota']) await add(app, name);
    const proposal = await propose(app);
    await post(app, `/api/match-proposals/${proposal.id}/apply`, { courtId: 1 });
    await post(app, '/api/courts/1/start');
    const mapping = { externalId: 'Member number', name: 'Preferred name', skillLevel: 'Group' };
    const saved = await post(app, '/api/roster/mapping', { mapping });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<AppSnapshot>().settings.rosterMapping).toEqual(mapping);
    expect(saved.json<AppSnapshot>().courts[0]!.status).toBe('in-play');
    expect((await post(app, '/api/roster/mapping', { mapping: { externalId: 'Name', name: 'name' } })).statusCode).toBe(400);
    expect((await state(app)).settings.rosterMapping).toEqual(mapping);
  });

  it('keeps 32 players unique with six simultaneous matches, then returns all completed players to the tail', async () => {
    const { app } = await open();
    const ids: string[] = [];
    for (let index = 1; index <= 32; index += 1) ids.push(await add(app, `Session player ${index}`));
    for (let courtId = 1; courtId <= 6; courtId += 1) {
      const proposal = await propose(app);
      expect((await post(app, `/api/match-proposals/${proposal.id}/apply`, { courtId })).statusCode).toBe(200);
      expect((await post(app, `/api/courts/${courtId}/start`)).statusCode).toBe(200);
    }
    const active = await state(app);
    expect(active.courts.filter((court) => court.status === 'in-play')).toHaveLength(6);
    expect(active.holdingPool.map((player) => player.id)).toEqual(ids.slice(24));
    const allIds = [...active.holdingPool, ...active.courts.flatMap((court) => court.players)].map((player) => player.id);
    expect(new Set(allIds).size).toBe(32);
    const ended = await Promise.all([1, 2, 3, 4, 5, 6].map((courtId) => post(app, `/api/courts/${courtId}/end`)));
    expect(ended.every((response) => response.statusCode === 200)).toBe(true);
    const final = await state(app);
    expect(final.holdingPool.slice(0, 8).map((player) => player.id)).toEqual(ids.slice(24));
    expect(final.roster.filter((player) => player.gamesPlayed === 1)).toHaveLength(24);
    expect(final.gameHistory).toHaveLength(6);
  });
});
