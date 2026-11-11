import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMatchProposal, correctRecordedGame, createPlayer, requestMatchProposal, saveRosterMapping, voidActiveGame, voidRecordedGame } from './api';
afterEach(() => vi.unstubAllGlobals());

describe('showcase mutation API contract', () => {
  const mockFetch = () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  it('preserves a genuinely unknown rating', async () => {
    const fetch = mockFetch();
    await createPlayer('host', 'Alex', 'unrated', null, 'Balanced');
    expect(JSON.parse(fetch.mock.calls[0][1].body).skillRating).toBeNull();
  });
  it('only sends mixed review and approval on explicit requests', async () => {
    const fetch = mockFetch();
    await requestMatchProposal('host', true);
    await applyMatchProposal('host', 'p', 2, true);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ allowMixed: true });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ courtId: 2, approveMixed: true });
  });
  it('separates active void from recorded void and retains the reason', async () => {
    const fetch = mockFetch();
    await voidActiveGame('host', 1, 'Wrong start');
    await voidRecordedGame('host', 'g/one', 'Interrupted');
    expect(fetch.mock.calls[0][0]).toBe('/api/courts/1/void');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ reason: 'Wrong start' });
    expect(fetch.mock.calls[1][0]).toBe('/api/games/g%2Fone/void');
  });
  it('sends exact player identities and seconds when correcting', async () => {
    const fetch = mockFetch();
    const correction = { playerIds: ['a', 'b'], durationSeconds: 180, reason: 'Wrong duration' };
    await correctRecordedGame('host', 'g', correction);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(correction);
  });
  it('saves columns through scoped metadata rather than a full settings update', async () => {
    const fetch = mockFetch();
    await saveRosterMapping('host', { externalId: 'Member', name: 'Player' });
    expect(fetch.mock.calls[0][0]).toBe('/api/roster/mapping');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ mapping: { externalId: 'Member', name: 'Player' } });
  });
});
