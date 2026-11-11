import sample from '../../public/sample-roster.csv?raw';
import { describe, expect, it } from 'vitest';
import { getRosterCsvHeaders, inferRosterColumnMapping, parseRosterCsv, validateRosterColumnMapping } from './rosterCsv';
import type { RosterColumnMapping } from './rosterCsv';

const header = 'external_id,name,skill_level,skill_rating,play_style';
const csv = (...rows: string[]) => [header, ...rows].join('\n');

describe('parseRosterCsv', () => {
  it('reads BOM, CRLF, header aliases, trimmed values, and canonical enums', () => {
    expect(parseRosterCsv('\uFEFF PLAYER_ID,FULL_NAME,LEVEL,RATING,STYLE,notes\r\n p-1 , Alex Reyes , InTeRmEdIaTe , 3.25 , tAcTiCaL ,ignored\r\n')).toEqual([
      { externalId: 'p-1', name: 'Alex Reyes', skillLevel: 'intermediate', skillRating: 3.25, playStyle: 'Tactical' },
    ]);
  });

  it('preserves quoted commas, newlines, and escaped quotes', () => {
    expect(parseRosterCsv(csv('p-1,"Reyes, Alex ""Ace""\nJr.",advanced,4.5,Defensive'))).toEqual([
      { externalId: 'p-1', name: 'Reyes, Alex "Ace"\nJr.', skillLevel: 'advanced', skillRating: 4.5, playStyle: 'Defensive' },
    ]);
  });

  it('defaults an omitted or blank optional play style to Balanced', () => {
    expect(parseRosterCsv('id,player_name,skill_level,skill_rating\np-1,Alex,beginner,1')[0].playStyle).toBe('Balanced');
    expect(parseRosterCsv(csv('p-1,Alex,beginner,1,'))[0].playStyle).toBe('Balanced');
  });

  it('keeps identical names separate and treats external IDs as case-sensitive', () => {
    const rows = parseRosterCsv(csv('Player-1,Alex,beginner,1,Balanced', 'player-1,Alex,beginner,1,Balanced'));
    expect(rows.map((row) => row.externalId)).toEqual(['Player-1', 'player-1']);
  });

  it('rejects duplicate external IDs after trimming, including later rows', () => {
    expect(() => parseRosterCsv(csv('p-1,Alex,beginner,1,Balanced', ' p-1 ,Blair,advanced,5,Tactical'))).toThrow(/Row 3: duplicate external_id/);
  });

  it('rejects duplicate aliases of a canonical header', () => {
    expect(() => parseRosterCsv('external_id,player_id,name,level,rating\np-1,p-2,Alex,beginner,1')).toThrow(/external_id is provided more than once/);
  });

  it('gives actionable errors for missing external IDs without fabricating them', () => {
    expect(() => parseRosterCsv('name,level,rating\nAlex,beginner,1')).toThrow(/Add a stable external_id/);
    expect(() => parseRosterCsv(csv(',Alex,beginner,1,Balanced'))).toThrow(/Row 2: external_id is required.*stable ID/);
  });

  it.each([
    ['p-1,,beginner,1,Balanced', /name is required/],
    ['p-1,Alex,expert,3,Balanced', /skill_level must be/],
    ['p-1,Alex,beginner,3,Creative', /play_style must be/],
    [`${'x'.repeat(101)},Alex,beginner,1,Balanced`, /external_id must be 100/],
    [`p-1,${'x'.repeat(81)},beginner,1,Balanced`, /name must be 80/],
  ])('rejects invalid or missing fields in %s', (row, message) => {
    expect(() => parseRosterCsv(csv(row))).toThrow(message);
  });

  it.each(['0', '6.1', 'NaN', 'Infinity', '3.5abc', '0x3', '3e0'])('rejects invalid decimal rating %s', (rating) => {
    expect(() => parseRosterCsv(csv(`p-1,Alex,beginner,${rating},Balanced`))).toThrow(/decimal number from 1 to 6/);
  });

  it.each([
    ['p-1,"Alex,beginner,1,Balanced', /unterminated quoted field/],
    ['p-1,Al"ex,beginner,1,Balanced', /unexpected quote/],
    ['p-1,"Alex"extra,beginner,1,Balanced', /unexpected text after a closing quote/],
    ['p-1,Reyes, Alex,beginner,1,Balanced', /more fields than the header/],
  ])('rejects malformed CSV in %s', (row, message) => {
    expect(() => parseRosterCsv(csv(row))).toThrow(message);
  });

  it('accepts 200 data rows and rejects 201 without returning a partial roster', () => {
    const rows = Array.from({ length: 201 }, (_, index) => `p-${index},Alex,beginner,1,Balanced`);
    expect(parseRosterCsv(csv(...rows.slice(0, 200)))).toHaveLength(200);
    expect(() => parseRosterCsv(csv(...rows))).toThrow(/at most 200 player rows/);
  });

  it('ignores whitespace-only lines but validates empty comma-delimited records', () => {
    expect(parseRosterCsv(`${header}\n  \n\np-1,Alex,beginner,1,Balanced\n\n`)).toHaveLength(1);
    expect(() => parseRosterCsv(csv(',,,,', 'p-1,Alex,beginner,1,Balanced'))).toThrow(/external_id is required/);
  });

  it('rejects empty files, header-only files, and missing required headers', () => {
    expect(() => parseRosterCsv('\uFEFF \r\n')).toThrow(/CSV is empty/);
    expect(() => parseRosterCsv(header)).toThrow(/no player rows/);
    expect(() => parseRosterCsv('id,level\np-1,beginner')).toThrow(/Missing required CSV headers: name/);
  });

  it('records unknown levels and ratings without inferring either from the other', () => {
    expect(parseRosterCsv('id,name\np-1,Alex')).toEqual([
      { externalId: 'p-1', name: 'Alex', skillLevel: 'unrated', skillRating: null, playStyle: 'Balanced' },
    ]);
    const rows = parseRosterCsv(csv('p-1,Alex,,3.5,', 'p-2,Blair,advanced,,', 'p-3,Chris,UNRATED,,', 'p-4,Drew, , ,'));
    expect(rows.map(({ skillLevel, skillRating }) => ({ skillLevel, skillRating }))).toEqual([
      { skillLevel: 'unrated', skillRating: 3.5 },
      { skillLevel: 'advanced', skillRating: null },
      { skillLevel: 'unrated', skillRating: null },
      { skillLevel: 'unrated', skillRating: null },
    ]);
  });

  it('accepts custom header mapping, including quoted commas and escaped header quotes', () => {
    const text = '\uFEFF"Member, ID","Player ""name""",Division,Grade,Preference\r\nclub-41,Alex,Intermediate,3.25,Tactical\r\n';
    const mapping: RosterColumnMapping = { externalId: 'Member, ID', name: 'Player "name"', skillLevel: 'Division', skillRating: 'Grade', playStyle: 'Preference' };
    expect(getRosterCsvHeaders(text)).toEqual(['Member, ID', 'Player "name"', 'Division', 'Grade', 'Preference']);
    expect(parseRosterCsv(text, mapping)).toEqual([
      { externalId: 'club-41', name: 'Alex', skillLevel: 'intermediate', skillRating: 3.25, playStyle: 'Tactical' },
    ]);
  });

  it('makes explicit mappings authoritative rather than guessing omitted optional columns', () => {
    const text = 'external_id,id,name,level,rating\nwrong,p-1,Alex,not-a-level,not-a-rating';
    expect(parseRosterCsv(text, { externalId: 'id', name: 'name' })).toEqual([
      { externalId: 'p-1', name: 'Alex', skillLevel: 'unrated', skillRating: null, playStyle: 'Balanced' },
    ]);
    expect(() => parseRosterCsv('Membership,Participant\np-1,Alex')).toThrow(/external_id/);
    expect(() => parseRosterCsv('id,name\np-1,Alex', {})).toThrow(/external_id, name/);
  });

  it('retains invalid nonblank level and rating errors when custom columns are selected', () => {
    const mapping: RosterColumnMapping = { externalId: 'Membership', name: 'Participant', skillLevel: 'Division', skillRating: 'Grade' };
    expect(() => parseRosterCsv('Membership,Participant,Division,Grade\np-1,Alex,expert,', mapping)).toThrow(/skill_level must be/);
    expect(() => parseRosterCsv('Membership,Participant,Division,Grade\np-1,Alex,,unknown', mapping)).toThrow(/skill_rating must be/);
  });

  it('does not fabricate IDs or bypass duplicate IDs through a custom mapping', () => {
    const mapping: RosterColumnMapping = { externalId: 'Member', name: 'Participant' };
    expect(() => parseRosterCsv('Member,Participant\n,Alex', mapping)).toThrow(/stable ID/);
    expect(() => parseRosterCsv('Member,Participant\np-1,Alex\n p-1 ,Blair', mapping)).toThrow(/Row 3: duplicate external_id/);
  });

  it('rejects missing, reused, unsupported and ambiguous header mappings', () => {
    const headers = ['Member', 'Participant'];
    expect(() => validateRosterColumnMapping(headers, { externalId: 'Gone', name: 'Participant' })).toThrow(/not in this CSV/);
    expect(() => validateRosterColumnMapping(headers, { externalId: 'Member', name: 'Member' })).toThrow(/assigned more than once/);
    expect(() => validateRosterColumnMapping(headers, { externalId: '', name: 'Participant' })).toThrow(/not in this CSV/);
    expect(() => validateRosterColumnMapping(headers, { externalId: 'Member', name: 'Participant', password: 'Member' } as RosterColumnMapping)).toThrow(/supported roster field/);
    expect(() => parseRosterCsv('Member,member,Participant\np-1,p-2,Alex', { externalId: 'Member', name: 'Participant' })).toThrow(/unique header/);
    expect(() => getRosterCsvHeaders('id,id,name\np-1,p-2,Alex')).toThrow(/unique header/);
  });

  it('uses alias defaults only for known headers and trims header edges', () => {
    expect(inferRosterColumnMapping([' PLAYER_ID ', ' Full_Name ', 'LEVEL', 'RATING', 'notes'])).toEqual({ externalId: 'PLAYER_ID', name: 'Full_Name', skillLevel: 'LEVEL', skillRating: 'RATING' });
    expect(inferRosterColumnMapping(['Membership', 'Participant'])).toEqual({});
    expect(() => inferRosterColumnMapping(['external_id', 'id', 'name'])).toThrow(/external_id is provided more than once/);
    expect(getRosterCsvHeaders(' \r\n')).toEqual([]);
  });

  it('enforces the 512 KB limit in UTF-8 bytes before either mapping or parsing', () => {
    const text = `id,name,notes\np-1,Alex,${'é'.repeat(262_144)}`;
    expect(text.length).toBeLessThan(524_288);
    expect(() => parseRosterCsv(text)).toThrow(/512 KB/);
    expect(() => getRosterCsvHeaders(text)).toThrow(/512 KB/);
  });

  it('loads a full Australian-context club roster with stable IDs and unknown ratings intact', () => {
    const rows = parseRosterCsv(sample);
    expect(rows).toHaveLength(96);
    expect(rows.map((row) => row.externalId)).toEqual(Array.from({ length: 96 }, (_, index) => `member-${String(index + 1).padStart(3, '0')}`));
    expect(rows.slice(0, 4).map((row) => row.name)).toEqual(['Sarah Mitchell', 'James Wilson', 'Emma Nguyen', 'Daniel Patel']);
    expect(new Set(rows.map((row) => row.name)).size).toBe(96);
    expect(rows.some((row) => row.skillLevel === 'unrated' && row.skillRating === null)).toBe(true);
    expect(rows.filter((row) => row.skillLevel !== 'unrated').every((row) => row.skillRating !== null)).toBe(true);
    expect(sample.split('\n')[0]).toBe(header);
    expect(sample).not.toMatch(/sample|demo|synthetic/i);
  });
});
