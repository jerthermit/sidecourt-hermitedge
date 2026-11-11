import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Repository } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import type { HoldingCandidate } from '../src/models.js';

const candidates = [3.5, 3.5, 3.5, 3.5, 4].map((skillRating, index): HoldingCandidate => ({
  id: 'player-' + index, skillLevel: 'intermediate', skillRating, playStyle: 'Balanced', createdAt: index,
}));
afterEach(() => vi.unstubAllGlobals());

describe('deterministic matching without an external model', () => {
  it('repeats the same tie decision without sending a request or replacing queued players', async () => {
    const fetcher = vi.fn(() => { throw new Error('No external request is permitted'); });
    vi.stubGlobal('fetch', fetcher);
    const matcher = new Matchmaker();
    const first = await matcher.propose(candidates);
    expect(first.source).toBe('rules-fallback');
    expect(first.playerIds).toEqual(['player-0', 'player-1', 'player-2', 'player-3']);
    expect(await matcher.propose(candidates)).toEqual(first);
    expect(first.notice).not.toMatch(/AI|provider|not configured/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains singles and unknown ratings without invented numeric balance', async () => {
    const matcher = new Matchmaker();
    expect((await matcher.propose(candidates, 2)).playerIds).toEqual(['player-0', 'player-1']);
    const unknown = await matcher.propose(candidates.map(player => ({ ...player, skillRating: null })));
    expect(unknown.notice).toContain('without numeric balance');
    expect(unknown.source).toBe('rules-fallback');
    await expect(matcher.propose([])).rejects.toThrow('At least 4');
  });
  it('removes the former provider-status endpoint and ignores obsolete provider configuration', async () => {
    const config = loadConfig({ PUBLIC_DEMO: 'true', TOGETHER_API_KEY: 'obsolete-fictional-key', AI_DAILY_LIMIT: '-1' });
    expect(config).not.toHaveProperty('togetherApiKey');
    const app = await buildApp({ config, repository: new Repository(':memory:') });
    try {
      const visitor = (await app.inject({ method: 'POST', url: '/api/visitor-sessions' })).json<{ accessKey: string }>();
      const response = await app.inject({ method: 'GET', url: '/api/matching/status', headers: { authorization: 'Bearer ' + visitor.accessKey } });
      expect(response.statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/health' })).body).not.toContain('obsolete-fictional-key');
    } finally { await app.close(); }
  });
});
