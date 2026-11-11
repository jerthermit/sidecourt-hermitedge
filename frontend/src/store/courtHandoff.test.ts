import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelPendingRequests, OPERATOR_ACCESS_KEY_STORAGE_KEY } from '../lib/api';
import type { AppSnapshot, MatchProposal, Player } from '../types/models';
import { useAppStore } from './useAppStore';

vi.mock('../lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  cancelPendingRequests: vi.fn(),
}));

const operatorKey = 'handoff-operator';
const courtId = 3;

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
  for (let index = 0; index < 16; index++) await Promise.resolve();
};

const makePlayers = (): Player[] => Array.from({ length: 4 }, (_, index) => ({
  id: `p-${index + 1}`,
  name: `Player ${index + 1}`,
  skillLevel: 'intermediate',
  skillRating: 3.5,
  playStyle: 'Balanced',
  attendance: 'ready',
  source: null,
  externalId: null,
  location: { type: 'holding-pool', index },
  createdAt: index,
}));

const makeSnapshot = (completed = false): AppSnapshot => {
  const players = makePlayers();
  const roster: Player[] = completed ? players : players.map((player) => ({
    ...player, location: { type: 'court', courtId },
  }));
  return {
    roster,
    courts: [1, 2, 3].map((id) => ({
      id,
      status: id === courtId && !completed ? 'in-play' : 'available',
      players: id === courtId && !completed ? roster : [],
      gameStartedAt: id === courtId && !completed ? 1000 : null,
      timeElapsed: id === courtId && !completed ? 60 : 0,
    })),
    holdingPool: completed ? players : [],
    nextGamePool: { beginner: [], intermediate: [], advanced: [], mixed: [] },
    gameHistory: completed ? [{
      id: 'completed-game', courtId, playerIds: players.map((player) => player.id),
      players: players.map((player) => player.name), startedAt: 1000, endedAt: 61_000,
      duration: 60, status: 'completed', sessionId: 'session-1',
    }] : [],
    session: { id: 'session-1', name: 'Club night', startedAt: 1, endedAt: null },
    rotation: {
      requiredPlayers: 4,
      eligiblePlayerIds: completed ? players.map((player) => player.id) : [],
      needsMixedApproval: false,
      waitingBand: 'intermediate',
      missingPlayers: completed ? 0 : 4,
    },
    matchProposals: [],
  };
};

const makeProposal = (id = 'handoff-proposal'): MatchProposal => ({
  id,
  source: 'rules-fallback',
  targetLane: 'intermediate',
  players: makePlayers(),
  summary: 'Next eligible group.',
  notice: 'Review before applying.',
  expiresAt: Date.now() + 60_000,
  status: 'pending',
});

describe('court completion and proposal review handoff', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeStorage());
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.getState().logout();
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState(makeSnapshot());
    vi.mocked(cancelPendingRequests).mockClear();
  });

  it('deduplicates concurrent clicks and reviews the ended court without assigning or starting it', async () => {
    const completed = makeSnapshot(true);
    const proposal = makeProposal();
    fetchMock.mockResolvedValueOnce(jsonResponse(completed));
    fetchMock.mockResolvedValueOnce(jsonResponse(proposal));

    const first = useAppStore.getState().endGameAndReview(courtId);
    const second = useAppStore.getState().endGameAndReview(courtId);
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/courts/3/end', '/api/match-proposals',
    ]);
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
    expect(useAppStore.getState().gameHistory).toEqual(completed.gameHistory);
    expect(useAppStore.getState().gameHistory).toHaveLength(1);
    expect(useAppStore.getState().courts).toEqual(completed.courts);
    expect(useAppStore.getState().holdingPool).toEqual(completed.holdingPool);
    expect(useAppStore.getState().nextGamePool).toEqual(completed.nextGamePool);
    expect(useAppStore.getState().matchProposal).toEqual(proposal);
    expect(useAppStore.getState().matchProposals).toEqual([proposal]);
    expect(useAppStore.getState().matchProposalCourtId).toBe(courtId);
    expect(useAppStore.getState().isSaving).toBe(false);
    expect(useAppStore.getState().isProposalLoading).toBe(false);
  });

  it('publishes completion while the proposal is pending and keeps the whole handoff ahead of queued work', async () => {
    const completed = makeSnapshot(true);
    const provider = deferredResponse();
    const nextSave = deferredResponse();
    fetchMock.mockResolvedValueOnce(jsonResponse(completed));
    fetchMock.mockReturnValueOnce(provider.promise);
    fetchMock.mockReturnValueOnce(nextSave.promise);

    const handoff = useAppStore.getState().endGameAndReview(courtId);
    const save = useAppStore.getState().setPlayerAttendance('p-1', 'resting');
    await flushPromises();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/courts/3/end', '/api/match-proposals']);
    expect(useAppStore.getState().gameHistory).toEqual(completed.gameHistory);
    expect(useAppStore.getState().courts).toEqual(completed.courts);
    expect(useAppStore.getState().roster).toEqual(completed.roster);
    expect(useAppStore.getState().isSaving).toBe(true);
    expect(useAppStore.getState().isProposalLoading).toBe(true);

    provider.resolve(jsonResponse(makeProposal()));
    await expect(handoff).resolves.toBe(true);
    await flushPromises();
    expect(fetchMock.mock.calls[2][0]).toBe('/api/players/p-1/attendance');
    expect(useAppStore.getState().isSaving).toBe(true);
    nextSave.resolve(jsonResponse({ ...completed, matchProposals: [makeProposal()] }));
    await expect(save).resolves.toBe(true);
    expect(useAppStore.getState().isSaving).toBe(false);
  });

  it('keeps the completed snapshot and reports a proposal failure without retrying completion', async () => {
    const completed = makeSnapshot(true);
    fetchMock.mockResolvedValueOnce(jsonResponse(completed));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Matching service unavailable.' }, 503));

    await expect(useAppStore.getState().endGameAndReview(courtId)).resolves.toBe(false);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().gameHistory).toEqual(completed.gameHistory);
    expect(useAppStore.getState().courts).toEqual(completed.courts);
    expect(useAppStore.getState().holdingPool).toEqual(completed.holdingPool);
    expect(useAppStore.getState().error).toBe('Match ended. Matching service unavailable.');
    expect(useAppStore.getState().isSaving).toBe(false);
    expect(useAppStore.getState().isProposalLoading).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse(makeProposal()));
    await expect(useAppStore.getState().requestMatchProposal(false, courtId)).resolves.toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/courts/3/end', '/api/match-proposals', '/api/match-proposals',
    ]);
    expect(useAppStore.getState().matchProposalCourtId).toBe(courtId);
  });

  it.each([
    'incomplete band', 'mixed approval', 'closed session', 'missing session',
    'disabled court', 'occupied court', 'missing rotation',
  ])('commits completion without requesting a proposal for %s', async (condition) => {
    const completed = makeSnapshot(true);
    if (condition === 'incomplete band') completed.rotation!.eligiblePlayerIds = ['p-1', 'p-2', 'p-3'];
    if (condition === 'mixed approval') completed.rotation!.needsMixedApproval = true;
    if (condition === 'closed session') completed.session!.endedAt = Date.now();
    if (condition === 'missing session') completed.session = undefined;
    if (condition === 'disabled court') completed.courts[2].status = 'disabled';
    if (condition === 'occupied court') completed.courts[2].players = [completed.roster[0]];
    if (condition === 'missing rotation') completed.rotation = undefined;
    fetchMock.mockResolvedValueOnce(jsonResponse(completed));

    await expect(useAppStore.getState().endGameAndReview(courtId)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useAppStore.getState().gameHistory).toEqual(completed.gameHistory);
    expect(useAppStore.getState().matchProposal).toBeNull();
    expect(useAppStore.getState().matchProposalCourtId).toBeNull();
  });

  it('uses the returned required player count for singles', async () => {
    const completed = makeSnapshot(true);
    completed.rotation = { ...completed.rotation!, requiredPlayers: 2, eligiblePlayerIds: ['p-1', 'p-2'] };
    fetchMock.mockResolvedValueOnce(jsonResponse(completed));
    fetchMock.mockResolvedValueOnce(jsonResponse(makeProposal()));

    await expect(useAppStore.getState().endGameAndReview(courtId)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not request a proposal or change the active court when ending fails', async () => {
    const before = makeSnapshot();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Game already ended.' }, 409));

    await expect(useAppStore.getState().endGameAndReview(courtId)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useAppStore.getState().courts).toEqual(before.courts);
    expect(useAppStore.getState().gameHistory).toEqual([]);
    expect(useAppStore.getState().error).toBe('Game already ended.');
  });

  it('suppresses the old completion and provider request after an operator change during ending', async () => {
    const ending = deferredResponse();
    fetchMock.mockReturnValueOnce(ending.promise);
    const handoff = useAppStore.getState().endGameAndReview(courtId);
    await flushPromises();

    useAppStore.getState().setAccessKey('next-operator');
    ending.resolve(jsonResponse(makeSnapshot(true)));
    await expect(handoff).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useAppStore.getState().accessKey).toBe('next-operator');
    expect(useAppStore.getState().gameHistory).toEqual([]);
    expect(useAppStore.getState().isSaving).toBe(false);
  });

  it('does not begin the provider request when auth changes as completion is published', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeSnapshot(true)));
    let changed = false;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (!changed && state.gameHistory.length === 1) {
        changed = true;
        state.setAccessKey('next-operator');
      }
    });
    try {
      await expect(useAppStore.getState().endGameAndReview(courtId)).resolves.toBe(false);
    } finally {
      unsubscribe();
    }

    expect(changed).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useAppStore.getState().accessKey).toBe('next-operator');
    expect(useAppStore.getState().gameHistory).toEqual([]);
    expect(useAppStore.getState().matchProposalCourtId).toBeNull();
  });

  it.each(['operator change', 'logout'])('suppresses an old provider response after %s', async (change) => {
    const provider = deferredResponse();
    fetchMock.mockResolvedValueOnce(jsonResponse(makeSnapshot(true)));
    fetchMock.mockReturnValueOnce(provider.promise);
    const handoff = useAppStore.getState().endGameAndReview(courtId);
    await flushPromises();

    if (change === 'operator change') useAppStore.getState().setAccessKey('next-operator');
    else useAppStore.getState().logout();
    provider.resolve(jsonResponse(makeProposal()));
    await expect(handoff).resolves.toBe(false);

    expect(useAppStore.getState().matchProposal).toBeNull();
    expect(useAppStore.getState().matchProposalCourtId).toBeNull();
    expect(useAppStore.getState().gameHistory).toEqual([]);
    expect(useAppStore.getState().isSaving).toBe(false);
    expect(useAppStore.getState().isProposalLoading).toBe(false);
  });

  it('clears deduplication on auth change without old cleanup deleting a new handoff', async () => {
    const oldEnd = deferredResponse();
    const newEnd = deferredResponse();
    fetchMock.mockReturnValueOnce(oldEnd.promise);
    fetchMock.mockReturnValueOnce(newEnd.promise);
    fetchMock.mockResolvedValueOnce(jsonResponse(makeProposal()));
    const oldTask = useAppStore.getState().endGameAndReview(courtId);
    await flushPromises();
    useAppStore.getState().setAccessKey('next-operator');
    const newTask = useAppStore.getState().endGameAndReview(courtId);
    expect(newTask).not.toBe(oldTask);

    oldEnd.resolve(jsonResponse(makeSnapshot(true)));
    await expect(oldTask).resolves.toBe(false);
    await flushPromises();
    expect(useAppStore.getState().endGameAndReview(courtId)).toBe(newTask);
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer next-operator');
    expect(useAppStore.getState().isSaving).toBe(true);
    newEnd.resolve(jsonResponse(makeSnapshot(true)));
    await expect(newTask).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['end', 'proposal'])('uses normal authentication invalidation for a 401 during %s', async (stage) => {
    if (stage === 'proposal') fetchMock.mockResolvedValueOnce(jsonResponse(makeSnapshot(true)));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));

    await expect(useAppStore.getState().endGameAndReview(courtId)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(stage === 'proposal' ? 2 : 1);
    expect(useAppStore.getState().accessKey).toBeNull();
    expect(useAppStore.getState().authRequired).toBe(true);
    expect(useAppStore.getState().error).toBe('Invalid operator code.');
    expect(useAppStore.getState().gameHistory).toEqual([]);
    expect(useAppStore.getState().matchProposalCourtId).toBeNull();
    expect(sessionStorage.getItem(OPERATOR_ACCESS_KEY_STORAGE_KEY)).toBeNull();
    expect(cancelPendingRequests).toHaveBeenCalledOnce();
    expect(useAppStore.getState().isSaving).toBe(false);
    expect(useAppStore.getState().isProposalLoading).toBe(false);
  });
});

describe('proposal court context', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeStorage());
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.getState().logout();
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState(makeSnapshot(true));
  });

  it('retains court context only while reload retains the same pending proposal identity', async () => {
    const current = makeProposal();
    const newer = makeProposal('newer-proposal');
    const refreshed = { ...current, notice: 'Updated notice.' };
    useAppStore.setState({ matchProposal: current, matchProposals: [current], matchProposalCourtId: courtId });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...makeSnapshot(true), matchProposals: [newer, refreshed] }))
      .mockResolvedValueOnce(jsonResponse(null));

    await expect(useAppStore.getState().reload()).resolves.toBe(true);
    expect(useAppStore.getState().matchProposal).toEqual(refreshed);
    expect(useAppStore.getState().matchProposalCourtId).toBe(courtId);

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...makeSnapshot(true), matchProposals: [newer] }))
      .mockResolvedValueOnce(jsonResponse(null));
    await expect(useAppStore.getState().reload()).resolves.toBe(true);
    expect(useAppStore.getState().matchProposal).toEqual(newer);
    expect(useAppStore.getState().matchProposalCourtId).toBeNull();
  });

  it('does not restore a local court target when initializing a server proposal', async () => {
    const proposal = makeProposal();
    useAppStore.setState({ matchProposal: null, matchProposalCourtId: courtId });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...makeSnapshot(true), matchProposals: [proposal] }))
      .mockResolvedValueOnce(jsonResponse(null));

    await expect(useAppStore.getState().initialize()).resolves.toBe(true);
    expect(useAppStore.getState().matchProposal).toEqual(proposal);
    expect(useAppStore.getState().matchProposalCourtId).toBeNull();
  });

  it('clears the target when a generic proposal replaces a contextual review', async () => {
    useAppStore.setState({ matchProposal: makeProposal(), matchProposalCourtId: courtId });
    const proposal = makeProposal('generic-proposal');
    fetchMock.mockResolvedValueOnce(jsonResponse(proposal));

    await expect(useAppStore.getState().requestMatchProposal()).resolves.toBe(true);
    expect(useAppStore.getState().matchProposal).toEqual(proposal);
    expect(useAppStore.getState().matchProposalCourtId).toBeNull();
  });

  it.each(['dismiss', 'expired dismissal', 'apply', 'close', 'visitor reset', 'logout', 'operator change', 'missing proposal'])(
    'clears the target on %s', async (action) => {
      const proposal = makeProposal();
      useAppStore.setState({ matchProposal: proposal, matchProposals: [proposal], matchProposalCourtId: courtId });
      if (action === 'dismiss') {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...proposal, status: 'rejected' }));
        await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(true);
      }
      if (action === 'expired dismissal') {
        useAppStore.setState({ matchProposal: { ...proposal, expiresAt: Date.now() - 1 } });
        await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(true);
      }
      if (action === 'apply') {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeSnapshot(true)));
        await expect(useAppStore.getState().applyMatchProposal(courtId)).resolves.toBe(true);
      }
      if (action === 'close') {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeSnapshot(true)));
        await expect(useAppStore.getState().closeSession()).resolves.toBe(true);
      }
      if (action === 'visitor reset') {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeSnapshot(true)));
        await expect(useAppStore.getState().resetVisitorSession()).resolves.toBe(true);
      }
      if (action === 'logout') useAppStore.getState().logout();
      if (action === 'operator change') useAppStore.getState().setAccessKey('next-operator');
      if (action === 'missing proposal') {
        useAppStore.setState({ matchProposal: null });
        await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(true);
      }
      expect(useAppStore.getState().matchProposalCourtId).toBeNull();
    },
  );
});
