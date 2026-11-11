import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_REQUEST_TIMEOUT_MS, applyMatchProposal, createVisitorSession, exportSession, getPlayerDisplay, getSessionReport, importRoster, startSession } from './api';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const response = (payload: unknown) => ({ ok: true, json: async () => payload });

describe('session API contract', () => {
  it('starts empty unless the host explicitly opts into the previous roster', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ roster: [] }));
    vi.stubGlobal('fetch', fetch);
    await startSession('host', 'Tuesday social');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: 'Tuesday social' });
    await startSession('host', 'Wednesday social', true);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ name: 'Wednesday social', includePreviousRoster: true });
  });

  it('sends correction permission and the reviewed revision only with explicit import options', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ snapshot: {}, added: 0, skipped: 1 }));
    vi.stubGlobal('fetch', fetch);
    await importRoster('host', 'club roster', []);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ source: 'club roster', rows: [] });
    await importRoster('host', 'club roster', [], { updateExisting: true, revision: 17 });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ source: 'club roster', rows: [], updateExisting: true, revision: 17 });
  });

  it('loads only the selected protected report and encodes the session identifier', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ session: { id: 'session&one' } }));
    vi.stubGlobal('fetch', fetch);
    await getSessionReport('host', 'session&one');
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/session%26one/report');
    expect(fetch.mock.calls[0][1].method).toBe('GET');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer host');
  });
  it('does not send an operator credential when creating isolated visitor access', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ accessKey: 'visitor-token', expiresAt: 123 }));
    vi.stubGlobal('fetch', fetch);
    await expect(createVisitorSession()).resolves.toEqual({ accessKey: 'visitor-token', expiresAt: 123 });
    expect(fetch.mock.calls[0][0]).toBe('/api/visitor-sessions');
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('passes a selected court only on explicit approval', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ courts: [] }));
    vi.stubGlobal('fetch', fetch);
    await applyMatchProposal('host', 'proposal-1', 2);
    expect(fetch.mock.calls[0][0]).toBe('/api/match-proposals/proposal-1/apply');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ courtId: 2 });
  });

  it('uses only the scoped display bearer and read endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ courts: [] }));
    vi.stubGlobal('fetch', fetch);
    await getPlayerDisplay('display-only');
    expect(fetch.mock.calls[0][0]).toBe('/api/display');
    expect(fetch.mock.calls[0][1].method).toBe('GET');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer display-only');
  });

  it('downloads a selected archive as CSV, not JSON', async () => {
    const csv = '"Player","Games"\r\n"Alex","1"';
    const json = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => csv, json });
    vi.stubGlobal('fetch', fetch);
    await expect(exportSession('host', 'attendance', 'session&one')).resolves.toBe(csv);
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/export?kind=attendance&sessionId=session%26one');
    expect(json).not.toHaveBeenCalled();
  });

  it('also bounds a CSV body that never completes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => new Promise(() => undefined) }));
    const failed = expect(exportSession('host', 'matches')).rejects.toThrow('Request timed out.');
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
});
