import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const snapshot = {
  roster: [], holdingPool: [], gameHistory: [], matchProposals: [],
  courts: [{ id: 1, status: 'available', players: [], gameStartedAt: null, timeElapsed: 0 }],
  nextGamePool: { beginner: [], intermediate: [], advanced: [] },
  settings: { venueName: 'Club', courtCount: 1, timezone: 'Australia/Perth', gameMode: 'singles' },
  session: { id: 'session-one', name: 'Tuesday social', startedAt: 1, endedAt: null },
  sessions: [{ id: 'session-one', name: 'Tuesday social', startedAt: 1, endedAt: null }],
};
const response = (payload: unknown, status = 200) => ({
  ok: status === 200, status, statusText: '', json: async () => payload,
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_PUBLIC_DEMO', 'true');
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('public access lifecycle', () => {
  it('bootstraps once, persists only visitor access and commits live settings/session', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ accessKey: 'isolated-visitor', expiresAt: Date.now() + 60_000 }))
      .mockResolvedValueOnce(response(snapshot))
      .mockResolvedValueOnce(response(null));
    vi.stubGlobal('fetch', fetch);
    const { useAppStore } = await import('./useAppStore');
    await expect(Promise.all([useAppStore.getState().initialize(), useAppStore.getState().initialize()])).resolves.toEqual([true, true]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(useAppStore.getState().accessKey).toBe('isolated-visitor');
    expect(useAppStore.getState().settings).toEqual(snapshot.settings);
    expect(useAppStore.getState().session).toEqual(snapshot.session);
    expect(useAppStore.getState().isLoading).toBe(false);
    expect(useAppStore.getState().authRequired).toBe(false);
  });

  it('clears an expired visitor without replaying their action, then permits a fresh start', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ accessKey: 'visitor-one', expiresAt: 123 }))
      .mockResolvedValueOnce(response(snapshot))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ error: { message: 'Expired' } }, 401))
      .mockResolvedValueOnce(response({ accessKey: 'visitor-two', expiresAt: 456 }))
      .mockResolvedValueOnce(response(snapshot))
      .mockResolvedValueOnce(response(null));
    vi.stubGlobal('fetch', fetch);
    const { useAppStore } = await import('./useAppStore');
    await useAppStore.getState().initialize();
    await expect(useAppStore.getState().startGame(1)).resolves.toBe(false);
    expect(useAppStore.getState().accessKey).toBeNull();
    expect(useAppStore.getState().courts).toEqual([]);
    expect(useAppStore.getState().authRequired).toBe(true);
    expect(useAppStore.getState().error).toBe('Session expired. Start again.');
    await expect(useAppStore.getState().initialize()).resolves.toBe(true);
    expect(useAppStore.getState().accessKey).toBe('visitor-two');
    expect(fetch.mock.calls.filter(([url]) => url === '/api/courts/1/start')).toHaveLength(1);
  });

  it('does not report success or invent a board when visitor creation fails', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ error: { message: 'Try again shortly.' } }, 429));
    vi.stubGlobal('fetch', fetch);
    const { useAppStore } = await import('./useAppStore');
    await expect(useAppStore.getState().initialize()).resolves.toBe(false);
    expect(useAppStore.getState().courts).toEqual([]);
    expect(useAppStore.getState().error).toBe('Try again shortly.');
    expect(useAppStore.getState().isLoading).toBe(false);
  });
});
