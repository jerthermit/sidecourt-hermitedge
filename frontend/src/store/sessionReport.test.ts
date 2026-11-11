import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_PUBLIC_DEMO', 'false');
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('session report request lifecycle', () => {
  it('returns a report without replacing the live board snapshot', async () => {
    const report = { session: { id: 'archive' }, participants: [] };
    const fetcher = vi.fn(async () => response(report));
    vi.stubGlobal('fetch', fetcher);
    const { useAppStore } = await import('./useAppStore');
    useAppStore.getState().setAccessKey('operator-report-key');
    const before = useAppStore.getState().courts;
    await expect(useAppStore.getState().loadSessionReport('archive')).resolves.toEqual(report);
    expect(useAppStore.getState().courts).toBe(before);
    expect(useAppStore.getState().isLoading).toBe(false);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it('keeps failure recoverable without retrying automatically', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ error: { message: 'Report unavailable.' } }, 503))
      .mockResolvedValueOnce(response({ session: { id: 'archive' } }));
    vi.stubGlobal('fetch', fetcher);
    const { useAppStore } = await import('./useAppStore');
    useAppStore.getState().setAccessKey('operator-report-key');
    await expect(useAppStore.getState().loadSessionReport('archive')).resolves.toBeNull();
    expect(useAppStore.getState().error).toBe('Report unavailable.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(useAppStore.getState().loadSessionReport('archive')).resolves.toEqual({ session: { id: 'archive' } });
    expect(useAppStore.getState().error).toBeNull();
  });
  it('never returns an old operator’s report after access changes', async () => {
    let release!: (value: unknown) => void;
    const body = new Promise((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => body })));
    const { useAppStore } = await import('./useAppStore');
    useAppStore.getState().setAccessKey('operator-first-key');
    const pending = useAppStore.getState().loadSessionReport('old-archive');
    await Promise.resolve(); await Promise.resolve();
    useAppStore.getState().setAccessKey('operator-second-key');
    release({ session: { id: 'old-archive' }, participants: ['private-old-operator'] });
    await expect(pending).resolves.toBeNull();
    expect(useAppStore.getState().accessKey).toBe('operator-second-key');
    expect(useAppStore.getState().error).toBeNull();
  });
  it('clears expired access through the existing authorization lifecycle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { message: 'Expired.' } }, 401)));
    const { useAppStore } = await import('./useAppStore');
    useAppStore.getState().setAccessKey('operator-report-key');
    await expect(useAppStore.getState().loadSessionReport('archive')).resolves.toBeNull();
    expect(useAppStore.getState().authRequired).toBe(true);
    expect(useAppStore.getState().accessKey).toBeNull();
    expect(useAppStore.getState().isLoading).toBe(false);
  });
});

describe('daily report request lifecycle', () => {
  it('uses the authenticated date query without replacing the working board', async () => {
    const report = { date: '2026-11-07', courts: [], matches: [] };
    const fetcher = vi.fn(async (url: string, options: RequestInit) => { void url; void options; return response(report); });
    vi.stubGlobal('fetch', fetcher);
    const { useAppStore } = await import('./useAppStore');
    useAppStore.getState().setAccessKey('operator-report-key');
    const before = useAppStore.getState().courts;
    await expect(useAppStore.getState().loadDailyReport('2026-11-07')).resolves.toEqual(report);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/reports/daily?date=2026-11-07');
    expect(fetcher.mock.calls[0]![1].headers).toMatchObject({ Authorization: 'Bearer operator-report-key' });
    expect(useAppStore.getState().courts).toBe(before);
    expect(useAppStore.getState().isLoading).toBe(false);
  });
  it('returns a recoverable error and retries only on request', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ error: { message: 'Report unavailable.' } }, 503))
      .mockResolvedValueOnce(response({ date: '2026-11-07' }));
    vi.stubGlobal('fetch', fetcher);
    const { useAppStore } = await import('./useAppStore');
    useAppStore.getState().setAccessKey('operator-report-key');
    await expect(useAppStore.getState().loadDailyReport('2026-11-07')).resolves.toBeNull();
    expect(useAppStore.getState().error).toBe('Report unavailable.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(useAppStore.getState().loadDailyReport('2026-11-07')).resolves.toEqual({ date: '2026-11-07' });
    expect(useAppStore.getState().error).toBeNull();
  });
  it('does not return data after operator access changes', async () => {
    let release!: (value: unknown) => void;
    const body = new Promise((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => body })));
    const { useAppStore } = await import('./useAppStore');
    useAppStore.getState().setAccessKey('operator-first-key');
    const pending = useAppStore.getState().loadDailyReport('2026-11-07');
    await Promise.resolve(); await Promise.resolve();
    useAppStore.getState().setAccessKey('operator-second-key');
    release({ date: '2026-11-07', matches: ['old-private-record'] });
    await expect(pending).resolves.toBeNull();
    expect(useAppStore.getState().accessKey).toBe('operator-second-key');
  });
});
