import type { ClubSettings, RosterMapping } from '../types/models';

export const CLUB_CONFIGURATION_MAX_BYTES = 32_768;
const fields = ['venueName', 'courtCount', 'timezone', 'gameMode', 'courtNames', 'rotationMode', 'avoidRepeatPartners', 'rosterMapping'];
const rosterFields = ['externalId', 'name', 'skillLevel', 'skillRating', 'playStyle'];

function record(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new Error(`Invalid ${label}.`);
  return value.trim();
}

export function parseClubConfiguration(input: string): ClubSettings {
  if (new TextEncoder().encode(input).byteLength > CLUB_CONFIGURATION_MAX_BYTES) throw new Error('Configuration exceeds 32 KiB.');
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { throw new Error('Choose a valid JSON configuration.'); }
  const envelope = record(parsed, ['format', 'version', 'settings'], 'configuration');
  if (envelope.format !== 'sidecourt.club-settings' || envelope.version !== 1) throw new Error('Unsupported configuration format or version.');
  const value = record(envelope.settings, fields, 'club settings');
  const venueName = text(value.venueName, 80, 'venue name');
  const timezone = text(value.timezone, 80, 'time zone');
  try { new Intl.DateTimeFormat('en-AU', { timeZone: timezone }); } catch { throw new Error('Choose a valid time zone.'); }
  const courtCount = value.courtCount;
  if (typeof courtCount !== 'number' || !Number.isInteger(courtCount) || courtCount < 1 || courtCount > 16) throw new Error('Choose 1–16 courts.');
  if (!Array.isArray(value.courtNames) || value.courtNames.length !== courtCount) throw new Error('Provide one name per court.');
  const courtNames = value.courtNames.map((name) => text(name, 40, 'court name'));
  if (new Set(courtNames.map((name) => name.toLocaleLowerCase('en-AU'))).size !== courtCount) throw new Error('Court names must be distinct.');
  if (value.gameMode !== 'singles' && value.gameMode !== 'doubles') throw new Error('Choose singles or doubles.');
  if (value.rotationMode !== 'open' && value.rotationMode !== 'skill-banded') throw new Error('Choose a supported rotation policy.');
  if (typeof value.avoidRepeatPartners !== 'boolean') throw new Error('Invalid partner preference.');
  const mapping = record(value.rosterMapping, rosterFields, 'roster columns');
  const rosterMapping: RosterMapping = {};
  for (const [field, header] of Object.entries(mapping)) rosterMapping[field as keyof RosterMapping] = text(header, 100, 'roster column');
  const headers = Object.values(rosterMapping).map((header) => header.toLocaleLowerCase('en-AU'));
  if (new Set(headers).size !== headers.length) throw new Error('Use each CSV column once.');
  return { venueName, courtCount, timezone, gameMode: value.gameMode, courtNames,
    rotationMode: value.rotationMode, avoidRepeatPartners: value.avoidRepeatPartners, rosterMapping };
}

export function serializeClubConfiguration(settings: ClubSettings): string {
  // Explicit fields keep credentials, roster identities and future unrelated settings out.
  const configuration = { format: 'sidecourt.club-settings', version: 1, settings: {
    venueName: settings.venueName, courtCount: settings.courtCount, timezone: settings.timezone,
    gameMode: settings.gameMode,
    courtNames: settings.courtNames ?? Array.from({ length: settings.courtCount }, (_, index) => `Court ${index + 1}`),
    rotationMode: settings.rotationMode ?? 'open', avoidRepeatPartners: settings.avoidRepeatPartners ?? true,
    rosterMapping: Object.fromEntries(rosterFields.flatMap((field) => {
      const header = settings.rosterMapping?.[field as keyof RosterMapping]?.trim();
      return header ? [[field, header]] : [];
    })),
  } };
  const result = JSON.stringify(configuration, null, 2);
  parseClubConfiguration(result);
  return result;
}

export function downloadClubConfiguration(settings: ClubSettings): void {
  const url = URL.createObjectURL(new Blob([serializeClubConfiguration(settings)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sidecourt-club.json';
  document.body.appendChild(link);
  try { link.click(); } finally { link.remove(); URL.revokeObjectURL(url); }
}
