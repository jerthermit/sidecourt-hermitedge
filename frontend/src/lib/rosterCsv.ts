import type { RosterImportRow } from '../types/models';

export type RosterField = 'externalId' | 'name' | 'skillLevel' | 'skillRating' | 'playStyle';
export type RosterColumnMapping = Partial<Record<RosterField, string>>;

interface CsvRecord {
  values: string[];
  rowNumber: number;
}

const MAX_ROSTER_ROWS = 200;
const MAX_CSV_BYTES = 524_288;
const HEADER_ALIASES: Record<string, RosterField> = {
  external_id: 'externalId',
  id: 'externalId',
  player_id: 'externalId',
  name: 'name',
  full_name: 'name',
  player_name: 'name',
  level: 'skillLevel',
  skill_level: 'skillLevel',
  rating: 'skillRating',
  skill_rating: 'skillRating',
  style: 'playStyle',
  play_style: 'playStyle',
};
const FIELD_HEADERS: Record<RosterField, string> = {
  externalId: 'external_id',
  name: 'name',
  skillLevel: 'skill_level',
  skillRating: 'skill_rating',
  playStyle: 'play_style',
};
const REQUIRED_FIELDS: RosterField[] = ['externalId', 'name'];
const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced', 'unrated'] as const;
const PLAY_STYLES = ['Balanced', 'Aggressive', 'Tactical', 'Defensive'] as const;

// Row numbers count CSV records, including the header and blank lines. A quoted
// field can span multiple physical lines without starting another CSV record.
const readCsvRecords = (text: string): CsvRecord[] => {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) {
    throw new Error('Use a CSV smaller than 512 KB.');
  }
  const source = text.replace(/^\uFEFF/, '');
  const records: CsvRecord[] = [];
  let values: string[] = [];
  let field = '';
  let state: 'unquoted' | 'quoted' | 'after-quote' = 'unquoted';
  let rowNumber = 1;
  let blankRecord = true;

  const finishField = () => {
    values.push(field);
    field = '';
    state = 'unquoted';
  };

  const finishRecord = () => {
    finishField();
    if (!blankRecord) {
      records.push({ values, rowNumber });
      if (records.length > MAX_ROSTER_ROWS + 1) {
        throw new Error('CSV supports at most 200 player rows. Split the roster into smaller imports.');
      }
    }
    values = [];
    blankRecord = true;
    rowNumber += 1;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (state === 'quoted') {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          state = 'after-quote';
        }
      } else if (character === '\r') {
        field += '\n';
        if (source[index + 1] === '\n') index += 1;
      } else {
        field += character;
      }
      continue;
    }

    if (character === ',') {
      blankRecord = false;
      finishField();
      continue;
    }
    if (character === '\r' || character === '\n') {
      finishRecord();
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      continue;
    }
    if (state === 'after-quote') {
      if (character === ' ' || character === '\t') continue;
      throw new Error(`Row ${rowNumber}: unexpected text after a closing quote. Separate fields with commas.`);
    }
    if (character === '"') {
      if (field.trim() !== '') {
        throw new Error(`Row ${rowNumber}: unexpected quote. Quote the entire field and escape quotes as "".`);
      }
      field = '';
      state = 'quoted';
      blankRecord = false;
      continue;
    }
    field += character;
    if (character.trim() !== '') blankRecord = false;
  }

  if (state === 'quoted') {
    throw new Error(`Row ${rowNumber}: unterminated quoted field. Add its closing quote.`);
  }
  finishRecord();
  return records;
};

const normalizeHeaders = (values: string[]): string[] => {
  const seen = new Set<string>();
  return values.map((value) => {
    const header = value.trim();
    const normalized = header.toLowerCase();
    if (normalized && seen.has(normalized)) throw new Error(`CSV header "${header}" is repeated. Give each column a unique header.`);
    if (normalized) seen.add(normalized);
    return header;
  });
};

/** Return the actual column labels; parsing uses the same quoted-field rules. */
export const getRosterCsvHeaders = (text: string): string[] => {
  const [header] = readCsvRecords(text);
  return header ? normalizeHeaders(header.values) : [];
};

/** Known aliases only. An unknown name is never treated as a player identity. */
export const inferRosterColumnMapping = (headers: string[]): RosterColumnMapping => {
  const mapping: RosterColumnMapping = {};
  normalizeHeaders(headers).forEach((header) => {
    const normalized = header.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(HEADER_ALIASES, normalized)) return;
    const field = HEADER_ALIASES[normalized];
    if (mapping[field] !== undefined) {
      throw new Error(`CSV header ${FIELD_HEADERS[field]} is provided more than once. Keep one header per roster field.`);
    }
    mapping[field] = header;
  });
  return mapping;
};

/** Validate saved/user mappings without inspecting or changing player values. */
export const validateRosterColumnMapping = (headers: string[], mapping: RosterColumnMapping): void => {
  const available = normalizeHeaders(headers);
  const used = new Set<string>();
  Object.entries(mapping).forEach(([field, header]) => {
    if (!Object.prototype.hasOwnProperty.call(FIELD_HEADERS, field)) throw new Error('Choose a supported roster field.');
    if (typeof header !== 'string' || !header.trim() || !available.includes(header)) {
      throw new Error(`Column for ${FIELD_HEADERS[field as RosterField]} is not in this CSV. Choose an available header.`);
    }
    if (used.has(header)) throw new Error(`CSV column "${header}" is assigned more than once. Use a different column for each field.`);
    used.add(header);
  });
  const missingHeaders = REQUIRED_FIELDS.filter((field) => !mapping[field]);
  if (missingHeaders.length > 0) {
    const idGuidance = missingHeaders.includes('externalId')
      ? ' Add a stable external_id for each player; names are not used as IDs.'
      : '';
    throw new Error(`Missing required CSV headers: ${missingHeaders.map((field) => FIELD_HEADERS[field]).join(', ')}.${idGuidance}`);
  }
};

/** Parse and validate the entire roster, or throw without returning partial rows. */
export const parseRosterCsv = (text: string, mapping?: RosterColumnMapping): RosterImportRow[] => {
  const [header, ...records] = readCsvRecords(text);
  if (!header) {
    throw new Error('CSV is empty. Include external_id and name headers and player rows.');
  }
  const headers = normalizeHeaders(header.values);
  const selected = mapping ?? inferRosterColumnMapping(headers);
  validateRosterColumnMapping(headers, selected);
  const columns = new Map<RosterField, number>();
  Object.entries(selected).forEach(([field, label]) => columns.set(field as RosterField, headers.indexOf(label)));
  if (records.length === 0) {
    throw new Error('CSV has no player rows. Add at least one player below the header.');
  }

  const seenIds = new Set<string>();
  return records.map(({ values, rowNumber }) => {
    if (values.length > header.values.length) {
      throw new Error(`Row ${rowNumber}: more fields than the header. Quote values that contain commas.`);
    }
    const valueFor = (field: RosterField) => {
      const index = columns.get(field);
      return index === undefined ? '' : (values[index] ?? '').trim();
    };
    const externalId = valueFor('externalId');
    const name = valueFor('name');
    const level = valueFor('skillLevel').toLowerCase();
    const rating = valueFor('skillRating');
    const style = valueFor('playStyle');

    if (!externalId) {
      throw new Error(`Row ${rowNumber}: external_id is required. Add a stable ID for this player; names are not used as IDs.`);
    }
    if (externalId.length > 100) {
      throw new Error(`Row ${rowNumber}: external_id must be 100 characters or fewer.`);
    }
    if (seenIds.has(externalId)) {
      throw new Error(`Row ${rowNumber}: duplicate external_id "${externalId}". Give each player a unique stable ID.`);
    }
    if (!name) {
      throw new Error(`Row ${rowNumber}: name is required.`);
    }
    if (name.length > 80) {
      throw new Error(`Row ${rowNumber}: name must be 80 characters or fewer.`);
    }
    const skillLevel = level ? SKILL_LEVELS.find((candidate) => candidate === level) : 'unrated';
    if (!skillLevel) {
      throw new Error(`Row ${rowNumber}: skill_level must be beginner, intermediate, advanced, or unrated.`);
    }
    const skillRating = rating ? Number(rating) : null;
    if (rating && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(rating) || skillRating === null || !Number.isFinite(skillRating) || skillRating < 1 || skillRating > 6)) {
      throw new Error(`Row ${rowNumber}: skill_rating must be a decimal number from 1 to 6.`);
    }
    const playStyle = style
      ? PLAY_STYLES.find((candidate) => candidate.toLowerCase() === style.toLowerCase())
      : 'Balanced';
    if (!playStyle) {
      throw new Error(`Row ${rowNumber}: play_style must be Balanced, Aggressive, Tactical, or Defensive.`);
    }

    seenIds.add(externalId);
    return { externalId, name, skillLevel, skillRating, playStyle };
  });
};
