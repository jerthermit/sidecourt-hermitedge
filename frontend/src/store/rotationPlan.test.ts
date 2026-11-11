import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRotationPlan,
  getCurrentRotationPlan,
  rejectRotationPlan,
  requestRotationPlan,
} from '../lib/api';
import type { AppSnapshot, Player, RotationPlan } from '../types/models';
import { useAppStore } from './useAppStore';

vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), cancelPendingRequests: vi.fn() }));
const players: Player[] = Array.from({ length: 8 }, (_, index) => ({
  id: `player-${index}`, name: `Player ${index}`, skillLevel: 'intermediate', skillRating: 3.5,
  playStyle: 'Balanced', attendance: 'ready', source: null, externalId: null, createdAt: index,
  gamesPlayed: 0, location: { type: 'holding-pool', index },
}));
const snapshot = (assigned = false): AppSnapshot => ({
  roster: players, holdingPool: assigned ? [] : players, nextGamePool: { beginner: [], intermediate: [], advanced: [], mixed: [] },
  courts: [1, 2].map((id) => ({ id, name: `Court ${id}`, status: 'available', players: assigned ? players.slice((id - 1) * 4, id * 4) : [], gameStartedAt: null, timeElapsed: 0 })),
  gameHistory: [], matchProposals: [], session: { id: 'session-one', name: 'Club session', startedAt: 1, endedAt: null },
});
const plan = (): RotationPlan => ({
  id: 'plan-one', sessionId: 'session-one', revision: 4, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  status: 'pending', allowMixed: false, canMix: false, policy: { rotationMode: 'open', avoidRepeatPartners: true },
  assignments: [1, 2].map((courtId) => ({ courtId, courtName: `Court ${courtId}`, players: players.slice((courtId - 1) * 4, courtId * 4), mixed: false,
    metrics: { ratingDifference: 0, repeatPartners: 0, repeatOpponents: 0 } })), waiting: [], blockedReason: null,
});
const response = (payload: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as Response;
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  useAppStore.getState().logout(); useAppStore.getState().setAccessKey('operator-one');
  useAppStore.setState(snapshot());
});
afterEach(() => { useAppStore.getState().logout(); vi.unstubAllGlobals(); });

describe('rotation API and authoritative store', () => {
  it('sends review and explicit approval separately without client-chosen assignments', async () => {
    fetcher.mockResolvedValueOnce(response(plan())).mockResolvedValueOnce(response(snapshot(true)));
    await requestRotationPlan('host', true);
    await applyRotationPlan('host', 'plan/one', true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/rotation-plans', '/api/rotation-plans/plan%2Fone/apply']);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ allowMixed: true });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ approveMixed: true });
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer host');
  });

  it('reads and explicitly rejects the persisted review through separate endpoints', async () => {
    fetcher.mockResolvedValueOnce(response(plan())).mockResolvedValueOnce(response({ id: 'plan-one', status: 'rejected' }));
    await expect(getCurrentRotationPlan('host')).resolves.toMatchObject({ id: 'plan-one', status: 'pending' });
    await expect(rejectRotationPlan('host', 'plan/one')).resolves.toEqual({ id: 'plan-one', status: 'rejected' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/rotation-plans/current', '/api/rotation-plans/plan%2Fone/reject',
    ]);
    expect(fetcher.mock.calls[0][1].method).toBe('GET');
    expect(fetcher.mock.calls[1][1].method).toBe('POST');
  });

  it('restores only a live pending review for the loaded session', async () => {
    const review = plan();
    fetcher.mockResolvedValueOnce(response(snapshot())).mockResolvedValueOnce(response(review));
    await expect(useAppStore.getState().initialize()).resolves.toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/state', '/api/rotation-plans/current']);
    expect(useAppStore.getState().rotationPlan).toEqual(review);

    fetcher.mockResolvedValueOnce(response(snapshot())).mockResolvedValueOnce(response({
      ...review, sessionId: 'another-session', expiresAt: Date.now() - 1,
    }));
    await expect(useAppStore.getState().reload()).resolves.toBe(true);
    expect(useAppStore.getState().rotationPlan).toBeNull();
  });

  it('discards both load responses when the operator changes during restoration', async () => {
    const pending = deferred();
    fetcher.mockResolvedValueOnce(response(snapshot())).mockReturnValueOnce(pending.promise);
    const loading = useAppStore.getState().initialize(); await flush();
    useAppStore.getState().setAccessKey('operator-two');
    pending.resolve(response(plan()));
    await expect(loading).resolves.toBe(false);
    expect(useAppStore.getState().accessKey).toBe('operator-two');
    expect(useAppStore.getState().session).toBeUndefined();
    expect(useAppStore.getState().rotationPlan).toBeNull();
  });

  it('refreshes authoritative state and previews without moving anyone', async () => {
    const review = plan();
    fetcher.mockResolvedValueOnce(response(snapshot())).mockResolvedValueOnce(response(review));
    await expect(useAppStore.getState().requestRotationPlan()).resolves.toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/state', '/api/rotation-plans']);
    expect(useAppStore.getState().rotationPlan).toEqual(review);
    expect(useAppStore.getState().holdingPool).toEqual(players);
    expect(useAppStore.getState().courts.every((court) => court.players.length === 0)).toBe(true);
  });

  it('commits only the returned assignment snapshot and never starts a match', async () => {
    useAppStore.setState({ rotationPlan: plan() });
    const pending = deferred(); fetcher.mockReturnValueOnce(pending.promise);
    const assignment = useAppStore.getState().applyRotationPlan(); await flush();
    expect(useAppStore.getState().holdingPool).toEqual(players);
    expect(useAppStore.getState().isSaving).toBe(true);
    pending.resolve(response(snapshot(true)));
    await expect(assignment).resolves.toBe(true);
    expect(useAppStore.getState().rotationPlan).toBeNull();
    expect(useAppStore.getState().courts.map((court) => court.players.length)).toEqual([4, 4]);
    expect(useAppStore.getState().courts.every((court) => court.gameStartedAt === null)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([409, 503])('retains the review and board after HTTP %s without retrying uncertain writes', async (status) => {
    const review = plan(); useAppStore.setState({ rotationPlan: review });
    fetcher.mockResolvedValueOnce(response({ error: { message: 'Refresh the changed session.' } }, status));
    await expect(useAppStore.getState().applyRotationPlan()).resolves.toBe(false);
    expect(useAppStore.getState().rotationPlan).toEqual(review);
    expect(useAppStore.getState().holdingPool).toEqual(players);
    expect(useAppStore.getState().isSaving).toBe(false); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not issue a plan request after logout during the preceding state refresh', async () => {
    const pending = deferred(); fetcher.mockReturnValueOnce(pending.promise);
    const request = useAppStore.getState().requestRotationPlan(); await flush();
    useAppStore.getState().logout(); pending.resolve(response(snapshot()));
    await expect(request).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledOnce(); expect(useAppStore.getState().rotationPlan).toBeNull();
  });

  it('discards a late plan response after the operator changes', async () => {
    const pending = deferred(); fetcher.mockResolvedValueOnce(response(snapshot())).mockReturnValueOnce(pending.promise);
    const request = useAppStore.getState().requestRotationPlan(); await flush();
    useAppStore.getState().setAccessKey('operator-two'); pending.resolve(response(plan()));
    await expect(request).resolves.toBe(false);
    expect(useAppStore.getState().accessKey).toBe('operator-two'); expect(useAppStore.getState().rotationPlan).toBeNull();
  });

  it('requires a live review and exposes an explicit local clear', async () => {
    await expect(useAppStore.getState().applyRotationPlan()).resolves.toBe(false);
    useAppStore.setState({ rotationPlan: { ...plan(), expiresAt: Date.now() - 1 } });
    await expect(useAppStore.getState().applyRotationPlan()).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    useAppStore.getState().clearRotationPlan(); expect(useAppStore.getState().rotationPlan).toBeNull();
  });

  it('rejects an explicitly dismissed review so it stays closed after reload', async () => {
    const review = plan(); useAppStore.setState({ rotationPlan: review });
    fetcher.mockResolvedValueOnce(response({ id: review.id, status: 'rejected' }));
    await expect(useAppStore.getState().dismissRotationPlan()).resolves.toBe(true);
    expect(useAppStore.getState().rotationPlan).toBeNull();
    expect(fetcher.mock.calls[0][0]).toBe('/api/rotation-plans/plan-one/reject');

    fetcher.mockResolvedValueOnce(response(snapshot())).mockResolvedValueOnce(response(null));
    await expect(useAppStore.getState().reload()).resolves.toBe(true);
    expect(useAppStore.getState().rotationPlan).toBeNull();
  });

  it('retains the review when explicit dismissal fails', async () => {
    const review = plan(); useAppStore.setState({ rotationPlan: review });
    fetcher.mockResolvedValueOnce(response({ error: { message: 'Try again.' } }, 503));
    await expect(useAppStore.getState().dismissRotationPlan()).resolves.toBe(false);
    expect(useAppStore.getState().rotationPlan).toEqual(review);
  });
});
