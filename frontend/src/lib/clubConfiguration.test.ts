import { describe, expect, it } from 'vitest';
import { CLUB_CONFIGURATION_MAX_BYTES, parseClubConfiguration, serializeClubConfiguration } from './clubConfiguration';
import type { ClubSettings } from '../types/models';

const settings: ClubSettings = { venueName: 'Harbour', courtCount: 2, timezone: 'Australia/Sydney',
  gameMode: 'doubles', courtNames: ['North', 'South'], rotationMode: 'skill-banded', avoidRepeatPartners: true,
  rosterMapping: { externalId: 'Member ID', name: 'Full name' } };
const change = (patch: Record<string, unknown>) => JSON.stringify({ format: 'sidecourt.club-settings', version: 1, settings: { ...settings, ...patch } });

describe('portable club configuration', () => {
  it('round trips supported saved settings', () => {
    expect(parseClubConfiguration(serializeClubConfiguration(settings))).toEqual(settings);
  });
  it('round trips all 16 configured court names', () => {
    const extended = { ...settings, courtCount: 16,
      courtNames: Array.from({ length: 16 }, (_, index) => `Harbour ${index + 1}`) };
    expect(parseClubConfiguration(serializeClubConfiguration(extended))).toEqual(extended);
  });
  it('rejects a seventeenth court even with a complete list of names', () => {
    expect(() => parseClubConfiguration(change({ courtCount: 17,
      courtNames: Array.from({ length: 17 }, (_, index) => `Court ${index + 1}`) }))).toThrow('Choose 1–16 courts.');
  });
  it('exports only configuration, never extra runtime data or credentials', () => {
    const enriched = { ...settings, accessKey: 'private-key', players: [{ name: 'Private player' }], history: ['private-record'] };
    const result = serializeClubConfiguration(enriched);
    expect(result).not.toMatch(/private-|Private player|accessKey|players|history/);
    expect(parseClubConfiguration(result)).toEqual(settings);
  });
  it.each([
    { courtCount: 0 }, { courtCount: 1.5 }, { courtNames: ['North'] }, { courtNames: ['North', ' north '] },
    { timezone: 'Unknown/Place' }, { gameMode: 'tournament' }, { rotationMode: 'winner-stays' },
    { avoidRepeatPartners: 'true' }, { venueName: '' }, { courtNames: [null, 'South'] },
    { rosterMapping: { name: 'Full name', externalId: 'full NAME' } }, { rosterMapping: { apiKey: 'secret' } },
    { players: [] }, { rosterMapping: null },
  ])('rejects invalid or out-of-scope settings: %j', (patch) => expect(() => parseClubConfiguration(change(patch))).toThrow());
  it.each(['not JSON', 'null', '[]', '{}', '{"format":"sidecourt.club-settings","version":2,"settings":{}}'])('rejects malformed or future formats', (input) => {
    expect(() => parseClubConfiguration(input)).toThrow();
  });
  it('rejects oversized UTF-8 data and unexpected top-level fields', () => {
    expect(() => parseClubConfiguration(' '.repeat(CLUB_CONFIGURATION_MAX_BYTES + 1))).toThrow('32 KiB');
    const envelope = JSON.parse(serializeClubConfiguration(settings));
    expect(() => parseClubConfiguration(JSON.stringify({ ...envelope, accessKey: 'no' }))).toThrow();
  });
});
