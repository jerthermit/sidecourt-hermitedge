import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assignStagedGroup, cancelPendingRequests } from '../lib/api';
import type { AppSnapshot, Player, StagedGroupAssignment } from '../types/models';
import { useAppStore } from './useAppStore';

vi.mock('../lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  // Let old responses complete so auth revision checks are tested independently of abort support.
  cancelPendingRequests: vi.fn(),
}));

const accessKey = 'staged-group-visitor-one';
const courtId = 2;
const ids = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const reviewedIds = [ids[2], ids[0], ids[3], ids[1]];
const sessionId = '10000000-0000-4000-8000-000000000001';

const makeStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};
const jsonResponse = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status >= 200 && status < 300 ? 'OK' : 'Request failed',
  json: vi.fn().mockResolvedValue(body),
}) as unknown as Response;
const deferredResponse = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => { resolve = complete; });
  return { promise, resolve };
};
const flushPromises = async () => {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
};

function makeSnapshot(assigned = false, visitor = 1): AppSnapshot {
  const order = [...reviewedIds, ids[4]];
  const players: Player[] = order.map((id, index) => ({
    id: visitor === 1 ? id : `visitor-${visitor}-${id}`,
    name: `Visitor ${visitor} player ${index + 1}${assigned ? ' confirmed' : ''}`,
    skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced',
    attendance: 'ready', source: null, externalId: null, createdAt: index,
    gamesPlayed: 0, playedSeconds: 0,
    location: assigned && index < 4
      ? { type: 'court', courtId } : { type: 'next-game-pool', lane: 'intermediate' },
  }));
  const waiting: Player = {
    ...players[0], id: `waiting-${visitor}`, name: `Visitor ${visitor} waiting player`,
    location: { type: 'holding-pool', index: 0 },
  };
  const session = { id: visitor === 1 ? sessionId : `session-visitor-${visitor}`,
    name: `Visitor ${visitor} session`, startedAt: 1, endedAt: null };
  return {
    roster: [...players, waiting],
    courts: [1, 2].map((id) => ({
      id, name: `Court ${id}`, status: 'available', players: assigned && id === courtId ? players.slice(0, 4) : [],
      gameStartedAt: null, timeElapsed: 0,
    })),
    holdingPool: [waiting],
    nextGamePool: { beginner: [], intermediate: assigned ? players.slice(4) : players, advanced: [], mixed: [] },
    gameHistory: [], matchProposals: [],
    settings: { venueName: `Visitor ${visitor} board${assigned ? ' confirmed' : ''}`, courtCount: 2,
      timezone: 'Asia/Manila', gameMode: 'doubles', rotationMode: 'skill-banded' },
    session, sessions: [session],
    rotation: { requiredPlayers: 4, eligiblePlayerIds: [waiting.id], missingPlayers: 3,
      needsMixedApproval: false, waitingBand: 'intermediate' },
  };
}
function groupFor(snapshot: AppSnapshot, approveMixed = false): StagedGroupAssignment {
  return { sessionId: snapshot.session!.id, lane: 'intermediate',
    playerIds: snapshot.nextGamePool.intermediate.slice(0, 4).map((player) => player.id), approveMixed };
}
function expectSnapshot(snapshot: AppSnapshot) {
  const current = useAppStore.getState();
  for (const field of ['roster', 'courts', 'holdingPool', 'nextGamePool', 'gameHistory', 'settings', 'session', 'sessions', 'rotation'] as const) {
    expect(current[field]).toEqual(snapshot[field]);
  }
}

describe('staged group API and store assignment', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeStorage());
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.getState().logout();
    useAppStore.getState().setAccessKey(accessKey);
    useAppStore.setState(makeSnapshot());
    vi.mocked(cancelPendingRequests).mockClear();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([false, true])('sends exactly one authenticated request preserving review order and approval %s', async (approveMixed) => {
    const server = makeSnapshot(true);
    fetchMock.mockResolvedValueOnce(jsonResponse(server));
    const group = groupFor(makeSnapshot(), approveMixed);

    await expect(assignStagedGroup(accessKey, courtId, group)).resolves.toBe(server);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/courts/2/assign-staged');
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({ Accept: 'application/json', Authorization: `Bearer ${accessKey}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(request.body)).toEqual({ sessionId, lane: 'intermediate', playerIds: reviewedIds, approveMixed });
    expect(Object.keys(JSON.parse(request.body)).sort()).toEqual(['approveMixed', 'lane', 'playerIds', 'sessionId']);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the staged group while pending and commits only the returned server snapshot', async () => {
    const before = makeSnapshot();
    const server = makeSnapshot(true);
    const pending = deferredResponse();
    fetchMock.mockReturnValueOnce(pending.promise);

    const assignment = useAppStore.getState().assignStagedGroup(courtId, groupFor(before));
    await flushPromises();
    expectSnapshot(before);
    expect(useAppStore.getState().isSaving).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    pending.resolve(jsonResponse(server));
    await expect(assignment).resolves.toBe(true);

    expectSnapshot(server);
    expect(useAppStore.getState().courts[1].players.map((player) => player.id)).toEqual(reviewedIds);
    expect(useAppStore.getState().nextGamePool.intermediate.map((player) => player.id)).toEqual([ids[4]]);
    expect(useAppStore.getState().courts[1]).toMatchObject({ status: 'available', gameStartedAt: null, timeElapsed: 0 });
    expect(useAppStore.getState().gameHistory).toEqual([]);
    expect(useAppStore.getState().roster.every((player) => player.gamesPlayed === 0 && player.playedSeconds === 0)).toBe(true);
    expect(useAppStore.getState().isSaving).toBe(false);
    expect(useAppStore.getState().error).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/courts/2/assign-staged']);
  });

  it.each([409, 503])('preserves the original group on HTTP %s failure without automatically retrying', async (status) => {
    const before = makeSnapshot();
    const message = status === 409 ? 'The staged group changed. Review again.' : 'Assignment unavailable.';
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message } }, status));

    await expect(useAppStore.getState().assignStagedGroup(courtId, groupFor(before))).resolves.toBe(false);
    await flushPromises();

    expectSnapshot(before);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useAppStore.getState().isSaving).toBe(false);
    expect(useAppStore.getState().error).toBe(message);

    fetchMock.mockResolvedValueOnce(jsonResponse(makeSnapshot(true)));
    await expect(useAppStore.getState().assignStagedGroup(courtId, groupFor(before))).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves the original group on a network failure without retrying or moving individual players', async () => {
    const before = makeSnapshot();
    fetchMock.mockRejectedValueOnce(new Error('Connection lost.'));

    await expect(useAppStore.getState().assignStagedGroup(courtId, groupFor(before))).resolves.toBe(false);
    await flushPromises();

    expectSnapshot(before);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/courts/2/assign-staged']);
    expect(useAppStore.getState().error).toBe('Connection lost.');
    expect(useAppStore.getState().isSaving).toBe(false);
  });

  it('drops an old queued assignment after a visitor switch and runs new work with the new visitor credentials', async () => {
    const oldSave = deferredResponse();
    fetchMock.mockReturnValueOnce(oldSave.promise);
    const before = makeSnapshot();
    const saving = useAppStore.getState().setPlayerAttendance('waiting-1', 'resting');
    const queued = useAppStore.getState().assignStagedGroup(courtId, groupFor(before));
    await flushPromises();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/players/waiting-1/attendance']);

    const nextVisitor = makeSnapshot(false, 2);
    useAppStore.getState().setAccessKey('staged-group-visitor-two');
    useAppStore.setState(nextVisitor);
    oldSave.resolve(jsonResponse(makeSnapshot(true)));
    await expect(Promise.all([saving, queued])).resolves.toEqual([false, false]);
    await flushPromises();

    expectSnapshot(nextVisitor);
    expect(useAppStore.getState().accessKey).toBe('staged-group-visitor-two');
    expect(useAppStore.getState().isSaving).toBe(false);
    expect(useAppStore.getState().error).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();

    const nextServer = makeSnapshot(true, 2);
    fetchMock.mockResolvedValueOnce(jsonResponse(nextServer));
    await expect(useAppStore.getState().assignStagedGroup(courtId, groupFor(nextVisitor))).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer staged-group-visitor-two');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(groupFor(nextVisitor));
    expectSnapshot(nextServer);
  });

  it.each([200, 401])('ignores an old in-flight assignment response with HTTP %s after switching visitors', async (status) => {
    const pending = deferredResponse();
    fetchMock.mockReturnValueOnce(pending.promise);
    const assignment = useAppStore.getState().assignStagedGroup(courtId, groupFor(makeSnapshot()));
    await flushPromises();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${accessKey}`);

    const nextVisitor = makeSnapshot(false, 2);
    useAppStore.getState().setAccessKey('staged-group-visitor-two');
    useAppStore.setState(nextVisitor);
    pending.resolve(jsonResponse(status === 200 ? makeSnapshot(true) : { error: { message: 'Old visitor expired.' } }, status));
    await expect(assignment).resolves.toBe(false);
    await flushPromises();

    expectSnapshot(nextVisitor);
    expect(useAppStore.getState().accessKey).toBe('staged-group-visitor-two');
    expect(useAppStore.getState().authRequired).toBe(false);
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().isSaving).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
