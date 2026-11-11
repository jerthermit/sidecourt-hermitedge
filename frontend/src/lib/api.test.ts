import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_REQUEST_TIMEOUT_MS, ApiError, cancelPendingRequests, getAppState } from './api';
import { useAppStore } from '../store/useAppStore';

const jsonResponse = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'Request failed',
  json: vi.fn().mockResolvedValue(body),
}) as unknown as Response;

afterEach(() => {
  useAppStore.getState().logout();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('API request recovery', () => {
  it('bounds a stalled fetch and permits an explicit fresh request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(jsonResponse({ roster: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const request = getAppState('synthetic-key');
    const failed = expect(request).rejects.toThrow('Request timed out. Refresh to check the latest state.');
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    await failed;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(getAppState('synthetic-key')).resolves.toEqual({ roster: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('also bounds a response whose JSON body never settles', async () => {
    vi.useFakeTimers();
    const response = jsonResponse({});
    response.json = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const failed = expect(getAppState('synthetic-key')).rejects.toThrow('Request timed out.');
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('immediately settles cancellation even if a transport ignores its signal', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetchMock);

    const failed = expect(getAppState('synthetic-key')).rejects.toThrow('Request cancelled.');
    cancelPendingRequests();
    await failed;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves HTTP errors and clears the deadline after a completed response', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'Wait and retry.' } }, 429)));
    await expect(getAppState('synthetic-key')).rejects.toEqual(new ApiError('Wait and retry.', 429));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases queued reload after a real API timeout without inventing a successful mutation', async () => {
    vi.useFakeTimers();
    const savedKeys = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => savedKeys.get(key) ?? null,
      setItem: (key: string, value: string) => savedKeys.set(key, value),
      removeItem: (key: string) => savedKeys.delete(key),
    });
    useAppStore.getState().setAccessKey('synthetic-key');
    const snapshot = { roster: [], courts: [], holdingPool: [], nextGamePool: { beginner: [], intermediate: [], advanced: [] }, gameHistory: [], matchProposals: [] };
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse(null));
    vi.stubGlobal('fetch', fetchMock);

    const preview = useAppStore.getState().previewRosterImport('synthetic-source', []);
    const reload = useAppStore.getState().reload();
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    await expect(Promise.all([preview, reload])).resolves.toEqual([false, true]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/roster/preview', '/api/state', '/api/rotation-plans/current']);
    expect(useAppStore.getState().rosterImportPreview).toBeNull();
    expect(useAppStore.getState().isSaving).toBe(false);
    expect(useAppStore.getState().isLoading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a hung old-operator request and starts the new login immediately', async () => {
    vi.useFakeTimers();
    const savedKeys = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => savedKeys.get(key) ?? null,
      setItem: (key: string, value: string) => savedKeys.set(key, value),
      removeItem: (key: string) => savedKeys.delete(key),
    });
    useAppStore.getState().setAccessKey('synthetic-old-key');
    const snapshot = { roster: [], courts: [], holdingPool: [], nextGamePool: { beginner: [], intermediate: [], advanced: [] }, gameHistory: [], matchProposals: [] };
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse(null));
    vi.stubGlobal('fetch', fetchMock);

    const oldRequest = useAppStore.getState().reload();
    await Promise.resolve();
    useAppStore.getState().logout();
    useAppStore.getState().setAccessKey('synthetic-new-key');
    const login = useAppStore.getState().initialize();
    await expect(Promise.all([oldRequest, login])).resolves.toEqual([false, true]);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer synthetic-new-key');
    expect(useAppStore.getState().isLoading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
