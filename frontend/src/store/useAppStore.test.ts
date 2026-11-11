import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelPendingRequests, OPERATOR_ACCESS_KEY_STORAGE_KEY } from '../lib/api';
import type {
  AppSnapshot,
  MatchProposal,
  Player,
  RosterImportPreview,
  RosterImportRow,
} from '../types/models';
import { useAppStore } from './useAppStore';

vi.mock('../lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  cancelPendingRequests: vi.fn(),
}));

const operatorKey = 'operator-test-key';

const makeStorage = (): Storage => {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Request failed',
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as Response;

const makePlayer = (id: string, name: string, index: number): Player => ({
  id,
  name,
  skillLevel: 'intermediate',
  skillRating: 3.5,
  playStyle: 'Balanced',
  attendance: 'ready',
  source: null,
  externalId: null,
  location: { type: 'holding-pool', index },
  createdAt: 1_700_000_000_000 + index,
});

const makeSnapshot = (players: Player[] = [makePlayer('p-1', 'Alex', 0)]): AppSnapshot => ({
  roster: players,
  courts: Array.from({ length: 6 }, (_, index) => ({
    id: index + 1,
    status: 'available' as const,
    players: [],
    gameStartedAt: null,
    timeElapsed: 0,
  })),
  holdingPool: players,
  nextGamePool: {
    beginner: [],
    intermediate: [],
    advanced: [],
  },
  gameHistory: [],
});

const makeProposal = (players: Player[]): MatchProposal => ({
  id: 'proposal-1',
  source: 'rules-fallback',
  targetLane: 'intermediate',
  players,
  summary: 'Balanced group based on the current waiting list.',
  notice: 'Review before applying.',
  expiresAt: Date.now() + 60_000,
  status: 'pending',
});

const rosterSource = 'club-list';

const makeImportRow = (externalId = 'member-1'): RosterImportRow => ({
  externalId,
  name: 'Blair',
  skillLevel: 'intermediate',
  skillRating: 3.5,
  playStyle: 'Balanced',
});

const makePreview = (rows: RosterImportRow[] = [makeImportRow()]): RosterImportPreview => ({
  source: rosterSource,
  rows: rows.map((row) => ({ ...row, status: 'new', message: null })),
  newCount: rows.length,
  existingCount: 0,
  conflictCount: 0,
});

describe('useAppStore', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeStorage());
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    useAppStore.getState().logout();
    vi.mocked(cancelPendingRequests).mockReset();
  });

  it('bootstraps the authoritative snapshot with the session bearer key', async () => {
    const snapshot = makeSnapshot();
    sessionStorage.setItem(OPERATOR_ACCESS_KEY_STORAGE_KEY, operatorKey);
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot)).mockResolvedValueOnce(jsonResponse(null));

    await expect(useAppStore.getState().initialize()).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/state');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${operatorKey}`);
    expect(useAppStore.getState().roster).toEqual(snapshot.roster);
    expect(useAppStore.getState().holdingPool).toEqual(snapshot.holdingPool);
    expect(useAppStore.getState().courts).toHaveLength(6);
    expect(useAppStore.getState().authRequired).toBe(false);
  });

  it('keeps correction failures from changing active court assignments or counts', async () => {
    const before = makeSnapshot();
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState(before);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Session is closed.' }, 409));
    await expect(useAppStore.getState().correctRecordedGame('g', { playerIds: ['a', 'b'], durationSeconds: 60, reason: 'Wrong clock' })).resolves.toBe(false);
    expect(useAppStore.getState().courts).toEqual(before.courts);
    expect(useAppStore.getState().roster).toEqual(before.roster);
    expect(useAppStore.getState().isSaving).toBe(false);
  });

  it('commits saved columns and current rotation only from the server snapshot', async () => {
    const before = makeSnapshot();
    const rotation = { requiredPlayers: 4 as const, eligiblePlayerIds: [], needsMixedApproval: false, waitingBand: null, missingPlayers: 3 };
    const settings = { venueName: 'Club', courtCount: 6, gameMode: 'doubles' as const, timezone: 'Australia/Sydney', rosterMapping: { externalId: 'Member', name: 'Player' } };
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState(before);
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...before, settings, rotation }));
    await expect(useAppStore.getState().saveRosterMapping(settings.rosterMapping)).resolves.toBe(true);
    expect(useAppStore.getState().settings).toEqual(settings);
    expect(useAppStore.getState().rotation).toEqual(rotation);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/roster/mapping');
  });

  it('replaces state only with the snapshot returned by a successful mutation', async () => {
    const before = makeSnapshot();
    const created = makePlayer('p-2', 'Blair', 1);
    const after = makeSnapshot([...before.holdingPool, created]);
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState(before);
    fetchMock.mockResolvedValueOnce(jsonResponse(after));

    await expect(
      useAppStore.getState().addPlayer('Blair', 'intermediate', 3.5, 'Balanced'),
    ).resolves.toBe(true);

    expect(useAppStore.getState().holdingPool).toEqual(after.holdingPool);
    expect(useAppStore.getState().roster).toEqual(after.roster);
    expect(useAppStore.getState().isSaving).toBe(false);
    expect(useAppStore.getState().error).toBeNull();
  });

  it('retains the last snapshot and exposes the API error when a mutation fails', async () => {
    const before = makeSnapshot();
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState(before);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Court is already full.' }, 409));

    await expect(
      useAppStore
        .getState()
        .movePlayer(before.holdingPool[0].id, { type: 'court', courtId: 1 }),
    ).resolves.toBe(false);

    const state = useAppStore.getState();
    expect(state.courts).toEqual(before.courts);
    expect(state.roster).toEqual(before.roster);
    expect(state.holdingPool).toEqual(before.holdingPool);
    expect(state.nextGamePool).toEqual(before.nextGamePool);
    expect(state.error).toBe('Court is already full.');
    expect(state.isSaving).toBe(false);
  });

  it('stores a proposal without changing any queue', async () => {
    const snapshot = makeSnapshot();
    const proposal = makeProposal(snapshot.holdingPool);
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState(snapshot);
    fetchMock.mockResolvedValueOnce(jsonResponse(proposal));

    await expect(useAppStore.getState().requestMatchProposal()).resolves.toBe(true);

    const state = useAppStore.getState();
    expect(state.holdingPool).toEqual(snapshot.holdingPool);
    expect(state.roster).toEqual(snapshot.roster);
    expect(state.nextGamePool).toEqual(snapshot.nextGamePool);
    expect(state.courts).toEqual(snapshot.courts);
    expect(state.matchProposal).toEqual(proposal);
    expect(state.matchProposals).toEqual([proposal]);
  });

  it('applies a pending proposal only from the authoritative returned snapshot', async () => {
    const before = makeSnapshot();
    const proposal = makeProposal(before.holdingPool);
    const movedPlayer: Player = {
      ...before.holdingPool[0],
      location: { type: 'next-game-pool', lane: 'intermediate', matchGroupId: proposal.id },
    };
    const after: AppSnapshot = {
      ...before,
      roster: [movedPlayer],
      holdingPool: [],
      nextGamePool: {
        ...before.nextGamePool,
        intermediate: [movedPlayer],
      },
    };
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ ...before, matchProposal: proposal });
    fetchMock.mockResolvedValueOnce(jsonResponse(after));

    await expect(useAppStore.getState().applyMatchProposal()).resolves.toBe(true);

    const state = useAppStore.getState();
    expect(state.holdingPool).toEqual([]);
    expect(state.roster).toEqual([movedPlayer]);
    expect(state.nextGamePool.intermediate).toEqual([movedPlayer]);
    expect(state.matchProposal?.status).toBe('applied');
    expect(state.matchProposals).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/match-proposals/proposal-1/apply');
  });

  it('previews import classifications without changing the authoritative snapshot', async () => {
    const before = makeSnapshot();
    const rows = [makeImportRow(), makeImportRow('member-2'), makeImportRow('member-3')];
    const preview: RosterImportPreview = {
      source: rosterSource,
      rows: [
        { ...rows[0], status: 'new', message: null },
        { ...rows[1], status: 'existing', message: 'Already imported.' },
        { ...rows[2], status: 'conflict', message: 'Duplicate external identifier.' },
      ],
      newCount: 1,
      existingCount: 1,
      conflictCount: 1,
    };
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ ...before, rosterImportResult: { added: 2, skipped: 1 } });
    fetchMock.mockResolvedValueOnce(jsonResponse(preview));

    await expect(useAppStore.getState().previewRosterImport(rosterSource, rows)).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/roster/preview');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${operatorKey}`);
    expect(JSON.parse(init.body as string)).toEqual({ source: rosterSource, rows });
    const state = useAppStore.getState();
    expect(state.rosterImportPreview).toEqual(preview);
    expect(state.rosterImportResult).toBeNull();
    expect(state.roster).toEqual(before.roster);
    expect(state.holdingPool).toEqual(before.holdingPool);
    expect(state.nextGamePool).toEqual(before.nextGamePool);
    expect(state.courts).toEqual(before.courts);
    expect(state.gameHistory).toEqual(before.gameHistory);
    expect(state.isSaving).toBe(false);
  });

  it('imports the returned complete snapshot and records added and skipped counts', async () => {
    const before = makeSnapshot();
    const rows = [makeImportRow()];
    const imported: Player = {
      ...makePlayer('p-2', 'Blair', 1),
      attendance: 'expected',
      source: rosterSource,
      externalId: rows[0].externalId,
    };
    const after: AppSnapshot = {
      ...makeSnapshot([]),
      roster: [...before.roster, imported],
      nextGamePool: { beginner: [], intermediate: before.roster, advanced: [] },
      courts: before.courts.map((court) => ({ ...court, status: 'disabled' })),
      gameHistory: [{
        id: 'history-1',
        courtId: 1,
        players: ['Alex'],
        startedAt: 100,
        endedAt: 200,
        duration: 100,
      }],
    };
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ ...before, rosterImportPreview: makePreview(rows) });
    fetchMock.mockResolvedValueOnce(jsonResponse({ snapshot: after, added: 1, skipped: 2 }));

    await expect(useAppStore.getState().importRoster(rosterSource, rows)).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/roster/import');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${operatorKey}`);
    expect(JSON.parse(init.body as string)).toEqual({ source: rosterSource, rows });
    const state = useAppStore.getState();
    expect(state.roster).toEqual(after.roster);
    expect(state.holdingPool).toEqual(after.holdingPool);
    expect(state.nextGamePool).toEqual(after.nextGamePool);
    expect(state.courts).toEqual(after.courts);
    expect(state.gameHistory).toEqual(after.gameHistory);
    expect(state.rosterImportPreview).toBeNull();
    expect(state.rosterImportResult).toEqual({ added: 1, skipped: 2 });
    expect(state.isSaving).toBe(false);
  });

  it('keeps the snapshot and preview when an import fails validation', async () => {
    const before = makeSnapshot();
    const rows = [makeImportRow()];
    const preview = makePreview(rows);
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ ...before, rosterImportPreview: preview });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Import contains conflicting rows.' }, 409));

    await expect(useAppStore.getState().importRoster(rosterSource, rows)).resolves.toBe(false);

    const state = useAppStore.getState();
    expect(state.roster).toEqual(before.roster);
    expect(state.holdingPool).toEqual(before.holdingPool);
    expect(state.nextGamePool).toEqual(before.nextGamePool);
    expect(state.courts).toEqual(before.courts);
    expect(state.gameHistory).toEqual(before.gameHistory);
    expect(state.rosterImportPreview).toEqual(preview);
    expect(state.rosterImportResult).toBeNull();
    expect(state.error).toBe('Import contains conflicting rows.');
    expect(state.isSaving).toBe(false);
  });

  it('updates attendance from the returned snapshot without inferring queue changes', async () => {
    const ready = makePlayer('member/1', 'Alex', 0);
    const resting: Player = { ...ready, attendance: 'resting' };
    const before = makeSnapshot([ready]);
    const after = { ...makeSnapshot([]), roster: [resting] };
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState(before);
    fetchMock.mockResolvedValueOnce(jsonResponse(after));

    await expect(useAppStore.getState().setPlayerAttendance(ready.id, 'resting')).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/players/member%2F1/attendance');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${operatorKey}`);
    expect(JSON.parse(init.body as string)).toEqual({ attendance: 'resting' });
    expect(useAppStore.getState().roster).toEqual([resting]);
    expect(useAppStore.getState().holdingPool).toEqual([]);
    expect(useAppStore.getState().isSaving).toBe(false);
  });

  it('preserves the last attendance and queues when an attendance change is rejected', async () => {
    const before = makeSnapshot();
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState(before);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'End the game before changing attendance.' }, 409));

    await expect(
      useAppStore.getState().setPlayerAttendance(before.roster[0].id, 'departed'),
    ).resolves.toBe(false);

    expect(useAppStore.getState().roster).toEqual(before.roster);
    expect(useAppStore.getState().holdingPool).toEqual(before.holdingPool);
    expect(useAppStore.getState().error).toBe('End the game before changing attendance.');
    expect(useAppStore.getState().isSaving).toBe(false);
  });

  it('clears import feedback while retaining the roster and queue snapshot', () => {
    const before = makeSnapshot();
    useAppStore.setState({
      ...before,
      rosterImportPreview: makePreview(),
      rosterImportResult: { added: 1, skipped: 0 },
    });

    useAppStore.getState().clearRosterImport();

    expect(useAppStore.getState().rosterImportPreview).toBeNull();
    expect(useAppStore.getState().rosterImportResult).toBeNull();
    expect(useAppStore.getState().roster).toEqual(before.roster);
    expect(useAppStore.getState().holdingPool).toEqual(before.holdingPool);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['operator change', 'logout', 'blank operator code', 'missing saved code'])(
    'clears roster import feedback on %s',
    async (action) => {
      useAppStore.getState().setAccessKey(operatorKey);
      useAppStore.setState({
        ...makeSnapshot(),
        rosterImportPreview: makePreview(),
        rosterImportResult: { added: 1, skipped: 0 },
      });
      vi.mocked(cancelPendingRequests).mockClear();

      if (action === 'operator change') useAppStore.getState().setAccessKey('second-operator');
      if (action === 'logout') useAppStore.getState().logout();
      if (action === 'blank operator code') useAppStore.getState().setAccessKey('   ');
      if (action === 'missing saved code') {
        sessionStorage.removeItem(OPERATOR_ACCESS_KEY_STORAGE_KEY);
        await expect(useAppStore.getState().reload()).resolves.toBe(false);
      }

      expect(useAppStore.getState().rosterImportPreview).toBeNull();
      expect(useAppStore.getState().rosterImportResult).toBeNull();
      expect(useAppStore.getState().roster).toEqual([]);
      expect(cancelPendingRequests).toHaveBeenCalledOnce();
      expect(useAppStore.getState().isSaving).toBe(false);
      expect(useAppStore.getState().isLoading).toBe(false);
    },
  );

  it('clears import feedback when the API rejects the operator code', async () => {
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({
      rosterImportPreview: makePreview(),
      rosterImportResult: { added: 1, skipped: 0 },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));
    vi.mocked(cancelPendingRequests).mockClear();

    await expect(useAppStore.getState().previewRosterImport(rosterSource, [makeImportRow()]))
      .resolves.toBe(false);

    expect(useAppStore.getState().accessKey).toBeNull();
    expect(useAppStore.getState().authRequired).toBe(true);
    expect(useAppStore.getState().rosterImportPreview).toBeNull();
    expect(useAppStore.getState().rosterImportResult).toBeNull();
    expect(sessionStorage.getItem(OPERATOR_ACCESS_KEY_STORAGE_KEY)).toBeNull();
    expect(cancelPendingRequests).toHaveBeenCalledOnce();
    expect(useAppStore.getState().isSaving).toBe(false);
  });

  it('serializes preview and import requests through the shared operation queue', async () => {
    const rows = [makeImportRow()];
    let resolvePreview!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolvePreview = resolve;
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ snapshot: makeSnapshot(), added: 1, skipped: 0 }));
    useAppStore.getState().setAccessKey(operatorKey);

    const previewTask = useAppStore.getState().previewRosterImport(rosterSource, rows);
    const importTask = useAppStore.getState().importRoster(rosterSource, rows);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().isSaving).toBe(true);
    resolvePreview(jsonResponse(makePreview(rows)));
    await expect(Promise.all([previewTask, importTask])).resolves.toEqual([true, true]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/roster/preview', '/api/roster/import']);
    expect(useAppStore.getState().rosterImportPreview).toBeNull();
    expect(useAppStore.getState().rosterImportResult).toEqual({ added: 1, skipped: 0 });
    expect(useAppStore.getState().isSaving).toBe(false);
  });

  it('ignores a stale import response and cancels queued attendance after an operator change', async () => {
    let resolveImport!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveImport = resolve;
    }));
    useAppStore.getState().setAccessKey(operatorKey);
    const importTask = useAppStore.getState().importRoster(rosterSource, [makeImportRow()]);
    const attendanceTask = useAppStore.getState().setPlayerAttendance('p-1', 'ready');
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    useAppStore.getState().setAccessKey('second-operator');
    resolveImport(jsonResponse({ snapshot: makeSnapshot(), added: 1, skipped: 0 }));
    await expect(Promise.all([importTask, attendanceTask])).resolves.toEqual([false, false]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().accessKey).toBe('second-operator');
    expect(useAppStore.getState().roster).toEqual([]);
    expect(useAppStore.getState().rosterImportPreview).toBeNull();
    expect(useAppStore.getState().rosterImportResult).toBeNull();
    expect(useAppStore.getState().isSaving).toBe(false);
  });

  it('restores the newest valid pending proposal from initialization and defaults old snapshots to an empty collection', async () => {
    const snapshot = makeSnapshot();
    const expired = { ...makeProposal(snapshot.roster), id: 'expired', expiresAt: Date.now() - 1 };
    const newest = { ...makeProposal(snapshot.roster), id: 'newest' };
    const older = { ...makeProposal(snapshot.roster), id: 'older' };
    useAppStore.getState().setAccessKey(operatorKey);
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, matchProposals: [expired, newest, older] }))
      .mockResolvedValueOnce(jsonResponse(null));

    await expect(useAppStore.getState().initialize()).resolves.toBe(true);

    expect(useAppStore.getState().matchProposal).toEqual(newest);
    expect(useAppStore.getState().matchProposals).toEqual([newest, older]);
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot)).mockResolvedValueOnce(jsonResponse(null));
    await expect(useAppStore.getState().reload()).resolves.toBe(true);
    expect(useAppStore.getState().matchProposal).toBeNull();
    expect(useAppStore.getState().matchProposals).toEqual([]);
  });

  it('retains the current valid review instead of replacing it with a newer proposal on reload', async () => {
    const snapshot = makeSnapshot();
    const current = makeProposal(snapshot.roster);
    const newest = { ...current, id: 'newest' };
    const refreshed = { ...current, notice: 'Updated authoritative notice.' };
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ matchProposal: current, matchProposals: [current] });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, matchProposals: [newest, refreshed] }))
      .mockResolvedValueOnce(jsonResponse(null));

    await expect(useAppStore.getState().reload()).resolves.toBe(true);

    expect(useAppStore.getState().matchProposal).toEqual(refreshed);
    expect(useAppStore.getState().matchProposals).toEqual([newest, refreshed]);
  });

  it('removes a stale pending review when reload reports no pending proposals', async () => {
    const snapshot = makeSnapshot();
    const current = makeProposal(snapshot.roster);
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ matchProposal: current, matchProposals: [current] });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, matchProposals: [] }))
      .mockResolvedValueOnce(jsonResponse(null));

    await expect(useAppStore.getState().reload()).resolves.toBe(true);

    expect(useAppStore.getState().matchProposal).toBeNull();
    expect(useAppStore.getState().matchProposals).toEqual([]);
  });

  it('dismisses a locally expired pending review without sending a reject request or reopening it', async () => {
    const snapshot = makeSnapshot();
    const expired = { ...makeProposal(snapshot.roster), expiresAt: Date.now() - 1 };
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ matchProposal: expired, matchProposals: [expired] });

    await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().matchProposal).toBeNull();
    expect(useAppStore.getState().matchProposals).toEqual([]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, matchProposals: [expired] }))
      .mockResolvedValueOnce(jsonResponse(null));
    await expect(useAppStore.getState().reload()).resolves.toBe(true);
    expect(useAppStore.getState().matchProposal).toBeNull();
  });

  it.each([404, 409])('reconciles reject %s with authoritative state and closes a resolved review', async (status) => {
    const snapshot = makeSnapshot();
    const current = makeProposal(snapshot.roster);
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ matchProposal: current, matchProposals: [current] });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'This proposal is already resolved.' }, status));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, matchProposals: [] }));

    await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/match-proposals/proposal-1/reject', '/api/state',
    ]);
    expect(useAppStore.getState().matchProposal).toBeNull();
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().isProposalLoading).toBe(false);
  });

  it('keeps a failed rejection visible when reconciliation still reports the proposal pending', async () => {
    const snapshot = makeSnapshot();
    const current = makeProposal(snapshot.roster);
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ matchProposal: current, matchProposals: [current] });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Synthetic rejection conflict.' }, 409));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, matchProposals: [current] }));

    await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(false);

    expect(useAppStore.getState().matchProposal).toEqual(current);
    expect(useAppStore.getState().error).toBe('Synthetic rejection conflict.');
    expect(useAppStore.getState().isProposalLoading).toBe(false);
  });

  it('keeps a meaningful reject failure visible and permits a successful retry', async () => {
    const current = makeProposal(makeSnapshot().roster);
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ matchProposal: current, matchProposals: [current] });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Server unavailable.' }, 500));

    await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(false);
    expect(useAppStore.getState().matchProposal).toEqual(current);
    expect(useAppStore.getState().matchProposals).toEqual([current]);
    expect(useAppStore.getState().error).toBe('Server unavailable.');

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...current, status: 'rejected' }));
    await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(true);
    expect(useAppStore.getState().matchProposal).toBeNull();
    expect(useAppStore.getState().matchProposals).toEqual([]);
    expect(useAppStore.getState().error).toBeNull();
  });

  it('keeps the review when the reconciliation request itself fails', async () => {
    const current = makeProposal(makeSnapshot().roster);
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ matchProposal: current, matchProposals: [current] });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Already resolved.' }, 409));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Refresh unavailable.' }, 500));

    await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(false);

    expect(useAppStore.getState().matchProposal).toEqual(current);
    expect(useAppStore.getState().error).toBe('Refresh unavailable.');
    expect(useAppStore.getState().isProposalLoading).toBe(false);
  });

  it.each(['applied', 'rejected'] as const)('does not restore a %s review from a stale pending collection', async (status) => {
    const snapshot = makeSnapshot();
    const current = makeProposal(snapshot.roster);
    useAppStore.getState().setAccessKey(operatorKey);
    useAppStore.setState({ matchProposal: current, matchProposals: [current] });
    if (status === 'applied') {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, matchProposals: [] }));
      await expect(useAppStore.getState().applyMatchProposal()).resolves.toBe(true);
      await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(true);
    } else {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ...current, status }));
      await expect(useAppStore.getState().dismissMatchProposal()).resolves.toBe(true);
    }
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, matchProposals: [current] }))
      .mockResolvedValueOnce(jsonResponse(null));

    await expect(useAppStore.getState().reload()).resolves.toBe(true);

    expect(useAppStore.getState().matchProposal).toBeNull();
    expect(useAppStore.getState().matchProposals).toEqual([]);
  });

  it('resets old busy counts on operator change without letting old completion clear a new load', async () => {
    let resolveImport!: (response: Response) => void;
    let resolveLoad!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveImport = resolve; }));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveLoad = resolve; }));
    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    useAppStore.getState().setAccessKey(operatorKey);
    const importTask = useAppStore.getState().importRoster(rosterSource, [makeImportRow()]);
    await Promise.resolve();
    vi.mocked(cancelPendingRequests).mockClear();

    useAppStore.getState().setAccessKey('second-operator');
    expect(cancelPendingRequests).toHaveBeenCalledOnce();
    expect(useAppStore.getState().isSaving).toBe(false);
    const loadTask = useAppStore.getState().initialize();
    expect(useAppStore.getState().isLoading).toBe(true);
    expect(useAppStore.getState().isSaving).toBe(false);
    resolveImport(jsonResponse({ snapshot: makeSnapshot(), added: 1, skipped: 0 }));
    await expect(importTask).resolves.toBe(false);
    for (let index = 0; index < 6; index++) await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().isLoading).toBe(true);
    expect(useAppStore.getState().isSaving).toBe(false);
    resolveLoad(jsonResponse(makeSnapshot()));
    await expect(loadTask).resolves.toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/roster/import', '/api/state', '/api/rotation-plans/current',
    ]);
    expect(useAppStore.getState().isLoading).toBe(false);
  });
});
