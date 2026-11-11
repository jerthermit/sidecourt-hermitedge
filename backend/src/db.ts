import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AppError, badRequest, conflict, notFound } from './errors.js';
import type {
  AppSnapshot,
  Attendance,
  ClubSettings,
  Court,
  CourtStatus,
  DailyReport,
  Destination,
  GameHistory,
  HoldingCandidate,
  MatchProposal,
  Player,
  PlayerLocation,
  PlayStyle,
  ProposalDraft,
  ProposalSource,
  ProposalStatus,
  RosterImportPreview,
  RosterImportRow,
  SkillLevel,
  Session,
  SessionReport,
  QueueLane,
  RosterColumnMapping,
  RotationPlan,
  RotationPlanStatus,
} from './models.js';
import { attendanceStatuses, maxCourtCount, playStyles, skillLevels, queueLanes } from './models.js';
import { buildRotationAssignments } from './rotation.js';
import { PUBLIC_COURT_COUNT, publicCourtNames, publicRoster } from './publicFixture.js';
import { isReportDate, localReportDate } from './reportDate.js';

const SCHEMA_VERSION = 6;
const PROPOSAL_TTL_MS = 5 * 60 * 1000;
const ROTATION_PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_STORED_ROTATION_PLANS = 100;

interface PlayerRow {
  id: string;
  name: string;
  skill_level: string;
  skill_rating: number | null;
  play_style: string;
  attendance: Attendance;
  source: string | null;
  external_id: string | null;
  location_type: 'holding-pool' | 'next-game-pool' | 'court';
  next_lane: string | null;
  position: number;
  court_id: number | null;
  created_at: number;
  waiting_since: number | null;
}

interface CourtRow {
  id: number;
  status: CourtStatus;
  game_started_at: number | null;
}

interface HistoryRow {
  id: string;
  session_id: string;
  court_id: number;
  player_names_json: string;
  player_ids_json: string;
  started_at: number;
  ended_at: number;
  duration: number;
  status: 'completed' | 'voided';
  reason: string | null;
  corrected_at: number | null;
  court_name: string | null;
}

interface ProposalRow {
  id: string;
  source: ProposalSource;
  status: ProposalStatus;
  player_ids_json: string;
  target_lane: QueueLane;
  mixed: number;
  context_revision: number;
  notice: string;
  created_at: number;
  expires_at: number;
}

interface StoredRotationAssignment {
  courtId: number;
  courtName: string;
  playerIds: string[];
  mixed: boolean;
  metrics: {
    ratingDifference: number | null;
    repeatPartners: number;
    repeatOpponents: number;
  };
}

interface RotationPlanRow {
  id: string;
  session_id: string;
  revision: number;
  created_at: number;
  expires_at: number;
  status: RotationPlanStatus;
  allow_mixed: number;
  can_mix: number;
  rotation_mode: 'open' | 'skill-banded';
  avoid_repeat_partners: number;
  assignments_json: string;
  waiting_player_ids_json: string;
  blocked_reason: string | null;
  resolved_at: number | null;
}

interface CreatePlayerValues {
  name: string;
  skillLevel: SkillLevel;
  skillRating: number | null;
  playStyle: PlayStyle;
}

const recordingPlayers: ReadonlyArray<CreatePlayerValues & {
  location: 'holding-pool' | 'next-game-pool';
}> = [
  { name: 'Maddie Hartwell', skillLevel: 'beginner', skillRating: 2.3, playStyle: 'Balanced', location: 'holding-pool' },
  { name: 'Lachie Dempsey', skillLevel: 'beginner', skillRating: 2.6, playStyle: 'Defensive', location: 'holding-pool' },
  { name: 'Priya Narayan', skillLevel: 'intermediate', skillRating: 3.2, playStyle: 'Tactical', location: 'next-game-pool' },
  { name: 'Noah Tran', skillLevel: 'intermediate', skillRating: 3.5, playStyle: 'Balanced', location: 'next-game-pool' },
  { name: 'Chloe Fairbairn', skillLevel: 'intermediate', skillRating: 3.7, playStyle: 'Aggressive', location: 'next-game-pool' },
  { name: 'Oliver Haddad', skillLevel: 'intermediate', skillRating: 3.9, playStyle: 'Defensive', location: 'next-game-pool' },
  { name: 'Amelia Chen', skillLevel: 'advanced', skillRating: 4.4, playStyle: 'Tactical', location: 'holding-pool' },
  { name: 'Ethan McAllister', skillLevel: 'advanced', skillRating: 4.7, playStyle: 'Balanced', location: 'holding-pool' },
  { name: 'Zara Kapoor', skillLevel: 'advanced', skillRating: 5.0, playStyle: 'Aggressive', location: 'holding-pool' },
  { name: 'Harrison Bellamy', skillLevel: 'advanced', skillRating: 5.2, playStyle: 'Defensive', location: 'holding-pool' },
];

function isSkillLevel(value: string): value is SkillLevel {
  return skillLevels.includes(value as SkillLevel);
}

function isPlayStyle(value: string): value is PlayStyle {
  return playStyles.includes(value as PlayStyle);
}

function parseSkillLevel(value: string): SkillLevel {
  if (!isSkillLevel(value)) throw new Error('Stored player has an invalid skill level.');
  return value;
}

function parsePlayStyle(value: string): PlayStyle {
  if (!isPlayStyle(value)) throw new Error('Stored player has an invalid play style.');
  return value;
}

function parseQueueLane(value: string): QueueLane {
  if (!queueLanes.includes(value as QueueLane)) throw new Error('Stored next-game lane is invalid.');
  return value as QueueLane;
}

function parseJsonStringArray(value: string, label: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`Stored ${label} data is invalid.`);
  }
  return parsed;
}

function nowMs(): number {
  return Date.now();
}

function csvCell(value: string | number | null): string {
  const text = String(value ?? '');
  // Quoting alone does not stop spreadsheet formula execution on import.
  const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csv(rows: Array<Array<string | number | null>>): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export class Repository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.db = new Database(databasePath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    try { this.migrate(); }
    catch (error) { this.db.close(); throw error; }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  ping(): boolean {
    return this.db.prepare('SELECT 1 AS ok').pluck().get() === 1;
  }

  getSchemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  getPlayerCount(): number {
    return this.db.prepare('SELECT COUNT(*) FROM players').pluck().get() as number;
  }

  private migrate(): void {
    const currentVersion = this.getSchemaVersion();
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `Database schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}.`,
      );
    }

    if (currentVersion === 0) {
      const existingTables = this.db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .pluck()
        .all() as string[];
      if (existingTables.length > 0) {
        throw new Error(
          'DATABASE_PATH contains an unrecognized database. Use an empty path for the server database.',
        );
      }

      const migrateV1 = this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE courts (
            id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 6),
            status TEXT NOT NULL DEFAULT 'available'
              CHECK (status IN ('available', 'in-play', 'disabled')),
            game_started_at INTEGER,
            CHECK (
              (status = 'in-play' AND game_started_at IS NOT NULL)
              OR (status != 'in-play' AND game_started_at IS NULL)
            )
          );

          CREATE TABLE players (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
            skill_level TEXT NOT NULL
              CHECK (skill_level IN ('beginner', 'intermediate', 'advanced')),
            skill_rating REAL NOT NULL CHECK (skill_rating BETWEEN 1.0 AND 6.0),
            play_style TEXT NOT NULL
              CHECK (play_style IN ('Balanced', 'Aggressive', 'Tactical', 'Defensive')),
            location_type TEXT NOT NULL
              CHECK (location_type IN ('holding-pool', 'next-game-pool', 'court')),
            next_lane TEXT CHECK (next_lane IN ('beginner', 'intermediate', 'advanced')),
            position INTEGER NOT NULL CHECK (position >= 0),
            court_id INTEGER REFERENCES courts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            created_at INTEGER NOT NULL,
            CHECK (
              (location_type = 'holding-pool' AND next_lane IS NULL AND court_id IS NULL)
              OR (location_type = 'next-game-pool' AND next_lane IS NOT NULL AND court_id IS NULL)
              OR (location_type = 'court' AND next_lane IS NULL AND court_id IS NOT NULL)
            )
          );

          CREATE INDEX idx_players_location
            ON players(location_type, next_lane, court_id, position);

          CREATE TABLE game_history (
            id TEXT PRIMARY KEY,
            court_id INTEGER NOT NULL REFERENCES courts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            player_names_json TEXT NOT NULL CHECK (json_valid(player_names_json)),
            started_at INTEGER NOT NULL,
            ended_at INTEGER NOT NULL,
            duration INTEGER NOT NULL CHECK (duration >= 0),
            CHECK (ended_at >= started_at)
          );

          CREATE INDEX idx_game_history_court_end
            ON game_history(court_id, ended_at DESC);

          CREATE TABLE match_proposals (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL CHECK (source IN ('ai', 'rules-fallback')),
            status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'expired')),
            player_ids_json TEXT NOT NULL CHECK (json_valid(player_ids_json)),
            target_lane TEXT NOT NULL
              CHECK (target_lane IN ('beginner', 'intermediate', 'advanced')),
            notice TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            resolved_at INTEGER,
            CHECK (expires_at > created_at)
          );

          CREATE INDEX idx_match_proposals_status_expiry
            ON match_proposals(status, expires_at);

          CREATE TABLE audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
            created_at INTEGER NOT NULL
          );

          CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
        `);

        const insertCourt = this.db.prepare(
          `INSERT INTO courts (id, status, game_started_at) VALUES (?, 'available', NULL)`,
        );
        for (let courtId = 1; courtId <= 6; courtId += 1) insertCourt.run(courtId);
        this.db.pragma('user_version = 1');
      });
      migrateV1.immediate();
    }

    if (this.getSchemaVersion() === 1) {
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE players ADD COLUMN attendance TEXT NOT NULL DEFAULT 'ready'
            CHECK (attendance IN ('expected', 'ready', 'resting', 'departed'));
          ALTER TABLE players ADD COLUMN source TEXT
            CHECK (source IS NULL OR length(source) BETWEEN 1 AND 80);
          ALTER TABLE players ADD COLUMN external_id TEXT CHECK (
            (source IS NULL AND external_id IS NULL)
            OR (source IS NOT NULL AND external_id IS NOT NULL
                AND length(external_id) BETWEEN 1 AND 100)
          );
          CREATE UNIQUE INDEX idx_players_import_identity ON players(source, external_id);
        `);
        this.db.pragma('user_version = 2');
      }).immediate();
    }

    if (this.getSchemaVersion() === 2) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY, name TEXT NOT NULL,
            started_at INTEGER NOT NULL, ended_at INTEGER,
            CHECK (ended_at IS NULL OR ended_at >= started_at)
          );
          CREATE UNIQUE INDEX idx_one_open_session ON sessions((1)) WHERE ended_at IS NULL;
          CREATE TABLE club_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            venue_name TEXT NOT NULL, court_count INTEGER NOT NULL CHECK (court_count BETWEEN 1 AND 6),
            timezone TEXT NOT NULL, game_mode TEXT NOT NULL CHECK (game_mode IN ('doubles', 'singles')),
            current_session_id TEXT NOT NULL REFERENCES sessions(id)
          );
          CREATE TABLE session_players (
            session_id TEXT NOT NULL REFERENCES sessions(id),
            player_id TEXT NOT NULL, name TEXT NOT NULL, source TEXT, external_id TEXT,
            attendance TEXT NOT NULL, checked_in_at INTEGER,
            games_played INTEGER NOT NULL DEFAULT 0, played_seconds INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_id, player_id)
          );
          ALTER TABLE game_history ADD COLUMN session_id TEXT REFERENCES sessions(id);
          ALTER TABLE game_history ADD COLUMN player_ids_json TEXT NOT NULL DEFAULT '[]'
            CHECK (json_valid(player_ids_json));
          CREATE INDEX idx_game_history_session ON game_history(session_id, ended_at DESC);
        `);
        const id = randomUUID();
        const earliest = this.db.prepare('SELECT MIN(started_at) FROM game_history').pluck().get() as number | null;
        this.db.prepare('INSERT INTO sessions (id, name, started_at, ended_at) VALUES (?, ?, ?, NULL)')
          .run(id, 'Club session', earliest ?? nowMs());
        this.db.prepare(`INSERT INTO club_settings
          (id, venue_name, court_count, timezone, game_mode, current_session_id)
          VALUES (1, 'Court Operations', 6, 'Australia/Sydney', 'doubles', ?)`)
          .run(id);
        this.db.prepare('UPDATE game_history SET session_id = ?').run(id);
        // Legacy matches contain names only. Do not guess player identities or counts.
        this.syncSessionPlayers(this.db.prepare('SELECT id FROM players').pluck().all() as string[]);
        this.db.pragma('user_version = 3');
      }).immediate();
    }

    if (this.getSchemaVersion() === 3) {
      this.db.transaction(() => {
        // Rebuild constrained tables; no table references players or match_proposals.
        // Court foreign keys and active court rosters remain intact throughout migration.
        this.db.exec(`
          CREATE TABLE players_v4 (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
            skill_level TEXT NOT NULL CHECK (skill_level IN ('beginner','intermediate','advanced','unrated')),
            skill_rating REAL CHECK (skill_rating IS NULL OR skill_rating BETWEEN 1.0 AND 6.0),
            play_style TEXT NOT NULL CHECK (play_style IN ('Balanced','Aggressive','Tactical','Defensive')),
            location_type TEXT NOT NULL CHECK (location_type IN ('holding-pool','next-game-pool','court')),
            next_lane TEXT CHECK (next_lane IN ('beginner','intermediate','advanced','mixed')),
            position INTEGER NOT NULL CHECK (position >= 0),
            court_id INTEGER REFERENCES courts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            created_at INTEGER NOT NULL,
            attendance TEXT NOT NULL DEFAULT 'ready' CHECK (attendance IN ('expected','ready','resting','departed')),
            source TEXT CHECK (source IS NULL OR length(source) BETWEEN 1 AND 80),
            external_id TEXT CHECK ((source IS NULL AND external_id IS NULL)
              OR (source IS NOT NULL AND external_id IS NOT NULL AND length(external_id) BETWEEN 1 AND 100)),
            waiting_since INTEGER,
            CHECK ((location_type = 'holding-pool' AND next_lane IS NULL AND court_id IS NULL)
              OR (location_type = 'next-game-pool' AND next_lane IS NOT NULL AND court_id IS NULL)
              OR (location_type = 'court' AND next_lane IS NULL AND court_id IS NOT NULL))
          );
          INSERT INTO players_v4 (id,name,skill_level,skill_rating,play_style,location_type,next_lane,
            position,court_id,created_at,attendance,source,external_id,waiting_since)
            SELECT id,name,skill_level,skill_rating,play_style,location_type,next_lane,
              position,court_id,created_at,attendance,source,external_id,NULL FROM players;
          DROP TABLE players;
          ALTER TABLE players_v4 RENAME TO players;
          CREATE INDEX idx_players_location ON players(location_type,next_lane,court_id,position);
          CREATE UNIQUE INDEX idx_players_import_identity ON players(source,external_id);
          CREATE TABLE proposals_v4 (
            id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('ai','rules-fallback')),
            status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','expired')),
            player_ids_json TEXT NOT NULL CHECK (json_valid(player_ids_json)),
            target_lane TEXT NOT NULL CHECK (target_lane IN ('beginner','intermediate','advanced','mixed')),
            notice TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
            resolved_at INTEGER, mixed INTEGER NOT NULL DEFAULT 0 CHECK (mixed IN (0,1)),
            context_revision INTEGER NOT NULL DEFAULT 0, CHECK (expires_at > created_at)
          );
          INSERT INTO proposals_v4 (id,source,status,player_ids_json,target_lane,notice,created_at,expires_at,resolved_at)
            SELECT id,source,CASE WHEN status = 'pending' THEN 'expired' ELSE status END,
              player_ids_json,target_lane,notice,created_at,expires_at,resolved_at FROM match_proposals;
          DROP TABLE match_proposals;
          ALTER TABLE proposals_v4 RENAME TO match_proposals;
          CREATE INDEX idx_match_proposals_status_expiry ON match_proposals(status,expires_at);
          ALTER TABLE club_settings ADD COLUMN court_names_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(court_names_json));
          ALTER TABLE club_settings ADD COLUMN rotation_mode TEXT NOT NULL DEFAULT 'open' CHECK(rotation_mode IN ('open','skill-banded'));
          ALTER TABLE club_settings ADD COLUMN avoid_repeat_partners INTEGER NOT NULL DEFAULT 1 CHECK(avoid_repeat_partners IN (0,1));
          ALTER TABLE club_settings ADD COLUMN roster_mapping_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(roster_mapping_json));
          ALTER TABLE club_settings ADD COLUMN rotation_revision INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE game_history ADD COLUMN status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','voided'));
          ALTER TABLE game_history ADD COLUMN reason TEXT;
          ALTER TABLE game_history ADD COLUMN corrected_at INTEGER;
          ALTER TABLE game_history ADD COLUMN court_name TEXT;
          UPDATE game_history SET court_name = 'Court ' || court_id;
        `);
        const count = (this.db.prepare('SELECT court_count FROM club_settings WHERE id = 1').pluck().get() as number);
        this.db.prepare('UPDATE club_settings SET court_names_json = ? WHERE id = 1')
          .run(JSON.stringify(Array.from({ length: count }, (_, index) => `Court ${index + 1}`)));
        // Legacy data has no measured wait start; begin measuring at migration, never invent it.
        this.syncWaitingIntervals();
        const foreignKeyErrors = this.db.pragma('foreign_key_check') as unknown[];
        if (foreignKeyErrors.length) throw new Error('Database migration failed foreign-key validation.');
        this.db.pragma('user_version = 4');
      }).immediate();
    }

    if (this.getSchemaVersion() === 4) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE rotation_plans (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            revision INTEGER NOT NULL CHECK (revision >= 0),
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending','applied','expired','rejected')),
            allow_mixed INTEGER NOT NULL CHECK (allow_mixed IN (0,1)),
            can_mix INTEGER NOT NULL CHECK (can_mix IN (0,1)),
            rotation_mode TEXT NOT NULL CHECK (rotation_mode IN ('open','skill-banded')),
            avoid_repeat_partners INTEGER NOT NULL CHECK (avoid_repeat_partners IN (0,1)),
            assignments_json TEXT NOT NULL CHECK (json_valid(assignments_json)),
            waiting_player_ids_json TEXT NOT NULL CHECK (json_valid(waiting_player_ids_json)),
            blocked_reason TEXT,
            resolved_at INTEGER,
            CHECK (expires_at > created_at)
          );
          CREATE INDEX idx_rotation_plans_session_status
            ON rotation_plans(session_id, status, expires_at);
          CREATE UNIQUE INDEX idx_one_pending_rotation_plan
            ON rotation_plans(session_id) WHERE status = 'pending';
        `);
        this.db.pragma('user_version = 5');
      }).immediate();
    }

    if (this.getSchemaVersion() === 5) {
      // Both parent tables have legacy six-court CHECK constraints. Rebuild them
      // without renaming the originals so dependent foreign-key targets stay intact.
      // SQLite requires foreign_keys to change outside the transaction.
      this.db.pragma('foreign_keys = OFF');
      try {
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE courts_v6 (
              id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND ${maxCourtCount}),
              status TEXT NOT NULL DEFAULT 'available'
                CHECK (status IN ('available', 'in-play', 'disabled')),
              game_started_at INTEGER,
              CHECK ((status = 'in-play' AND game_started_at IS NOT NULL)
                OR (status != 'in-play' AND game_started_at IS NULL))
            );
            INSERT INTO courts_v6 (id, status, game_started_at)
              SELECT id, status, game_started_at FROM courts;
            DROP TABLE courts;
            ALTER TABLE courts_v6 RENAME TO courts;

            CREATE TABLE club_settings_v6 (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              venue_name TEXT NOT NULL,
              court_count INTEGER NOT NULL CHECK (court_count BETWEEN 1 AND ${maxCourtCount}),
              timezone TEXT NOT NULL,
              game_mode TEXT NOT NULL CHECK (game_mode IN ('doubles', 'singles')),
              current_session_id TEXT NOT NULL REFERENCES sessions(id),
              court_names_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(court_names_json)),
              rotation_mode TEXT NOT NULL DEFAULT 'open' CHECK (rotation_mode IN ('open','skill-banded')),
              avoid_repeat_partners INTEGER NOT NULL DEFAULT 1 CHECK (avoid_repeat_partners IN (0,1)),
              roster_mapping_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(roster_mapping_json)),
              rotation_revision INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO club_settings_v6 (id, venue_name, court_count, timezone, game_mode,
              current_session_id, court_names_json, rotation_mode, avoid_repeat_partners,
              roster_mapping_json, rotation_revision)
              SELECT id, venue_name, court_count, timezone, game_mode, current_session_id,
                court_names_json, rotation_mode, avoid_repeat_partners, roster_mapping_json,
                rotation_revision FROM club_settings;
            DROP TABLE club_settings;
            ALTER TABLE club_settings_v6 RENAME TO club_settings;
          `);
          if ((this.db.pragma('foreign_key_check') as unknown[]).length) {
            throw new Error('Database migration failed foreign-key validation.');
          }
          this.db.pragma('user_version = 6');
        }).immediate();
      } finally {
        this.db.pragma('foreign_keys = ON');
      }
    }

    const repairCourts = this.db.transaction(() => {
      const insertCourt = this.db.prepare(
        `INSERT OR IGNORE INTO courts (id, status, game_started_at)
         VALUES (?, 'available', NULL)`,
      );
      for (let courtId = 1; courtId <= maxCourtCount; courtId += 1) insertCourt.run(courtId);
    });
    repairCourts.immediate();
  }

  getSnapshot(): AppSnapshot {
    return this.db.transaction(() => {
      this.expirePendingProposals(nowMs());
      this.expirePendingRotationPlans(nowMs());
      return this.readSnapshot(nowMs());
    }).immediate();
  }

  getSettings(): ClubSettings {
    const row = this.db.prepare(`SELECT venue_name, court_count, timezone, game_mode,
      court_names_json, rotation_mode, avoid_repeat_partners, roster_mapping_json
      FROM club_settings WHERE id = 1`).get() as {
        venue_name: string; court_count: number; timezone: string; game_mode: 'doubles' | 'singles';
        court_names_json: string; rotation_mode: 'open' | 'skill-banded'; avoid_repeat_partners: number;
        roster_mapping_json: string;
      };
    return { venueName: row.venue_name, courtCount: row.court_count,
      timezone: row.timezone, gameMode: row.game_mode,
      courtNames: parseJsonStringArray(row.court_names_json, 'court names'),
      rotationMode: row.rotation_mode, avoidRepeatPartners: row.avoid_repeat_partners === 1,
      rosterMapping: JSON.parse(row.roster_mapping_json) as RosterColumnMapping };
  }

  updateSettings(input: Pick<ClubSettings, 'venueName' | 'courtCount' | 'timezone' | 'gameMode'>
    & Partial<ClubSettings>): AppSnapshot {
    const current = this.getSettings();
    const settings = { ...current, ...input,
      courtNames: input.courtNames ?? Array.from({ length: input.courtCount }, (_, index) =>
        current.courtNames[index] ?? `Court ${index + 1}`) };
    if (typeof settings.venueName !== 'string' || settings.venueName.trim().length < 1
      || settings.venueName.trim().length > 80 || !Number.isInteger(settings.courtCount)
      || settings.courtCount < 1 || settings.courtCount > maxCourtCount
      || (settings.gameMode !== 'singles' && settings.gameMode !== 'doubles')
      || typeof settings.timezone !== 'string' || settings.timezone.length > 80) {
      throw badRequest('Invalid club settings.');
    }
    try { new Intl.DateTimeFormat('en-AU', { timeZone: settings.timezone }).format(); }
    catch { throw badRequest('Choose a valid timezone.'); }
    if (!Array.isArray(settings.courtNames) || settings.courtNames.length !== settings.courtCount
      || settings.courtNames.some((name) => typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 40)
      || new Set(settings.courtNames.map((name) => name.trim().toLocaleLowerCase('en-AU'))).size !== settings.courtCount
      || !['open', 'skill-banded'].includes(settings.rotationMode)
      || typeof settings.avoidRepeatPartners !== 'boolean') throw badRequest('Invalid court names or rotation policy.');
    settings.courtNames = settings.courtNames.map((name) => name.trim());
    settings.rosterMapping = this.normalizeRosterMapping(settings.rosterMapping);
    return this.mutate(() => {
      this.assertNoActiveGames();
      const occupiedHiddenCourt = this.db.prepare(`SELECT id FROM players
        WHERE location_type = 'court' AND court_id > ? AND EXISTS (
          SELECT 1 FROM session_players sp WHERE sp.session_id = ? AND sp.player_id = players.id
        ) LIMIT 1`).get(settings.courtCount, this.currentSession().id);
      if (occupiedHiddenCourt) throw conflict('Clear courts being removed before reducing the court count.');
      if (settings.gameMode === 'singles' && this.db.prepare(`SELECT court_id FROM players
        WHERE location_type = 'court' AND EXISTS (
          SELECT 1 FROM session_players sp WHERE sp.session_id = ? AND sp.player_id = players.id
        ) GROUP BY court_id HAVING COUNT(*) > 2 LIMIT 1`).get(this.currentSession().id)) {
        throw conflict('Leave no more than two players on each court before choosing singles.');
      }
      this.db.prepare(`UPDATE club_settings SET venue_name = ?, court_count = ?, timezone = ?,
        game_mode = ?, court_names_json = ?, rotation_mode = ?, avoid_repeat_partners = ?,
        roster_mapping_json = ? WHERE id = 1`).run(settings.venueName.trim(), settings.courtCount,
        settings.timezone, settings.gameMode, JSON.stringify(settings.courtNames), settings.rotationMode,
        settings.avoidRepeatPartners ? 1 : 0, JSON.stringify(settings.rosterMapping));
      this.resolveAllProposals();
      this.audit('settings.updated', 'club_settings', '1', settings);
    }, true);
  }

  updateRosterMapping(mapping: RosterColumnMapping): AppSnapshot {
    const normalized = this.normalizeRosterMapping(mapping);
    return this.db.transaction(() => {
      this.db.prepare('UPDATE club_settings SET roster_mapping_json = ? WHERE id = 1').run(JSON.stringify(normalized));
      this.audit('roster.mapping.updated', 'club_settings', '1', { mapping: normalized });
      return this.readSnapshot(nowMs());
    }).immediate();
  }

  private normalizeRosterMapping(mapping: RosterColumnMapping): RosterColumnMapping {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw badRequest('Invalid roster columns.');
    const fields = ['externalId', 'name', 'skillLevel', 'skillRating', 'playStyle'];
    const normalized: RosterColumnMapping = {};
    const used = new Set<string>();
    for (const [field, header] of Object.entries(mapping)) {
      if (!fields.includes(field) || typeof header !== 'string' || header.trim().length > 100) {
        throw badRequest('Invalid roster columns.');
      }
      const value = header.trim();
      if (value && used.has(value)) throw badRequest('Choose a different column for each field.');
      if (value) used.add(value);
      normalized[field as keyof RosterColumnMapping] = value;
    }
    return normalized;
  }

  startSession(name: string, includePreviousRoster = false): AppSnapshot {
    const normalized = typeof name === 'string' ? name.trim() : '';
    if (normalized.length < 1 || normalized.length > 80) throw badRequest('Session name must contain 1 to 80 characters.');
    if (typeof includePreviousRoster !== 'boolean') throw badRequest('Choose whether to include the previous roster.');
    return this.db.transaction(() => {
      if (this.currentSession().endedAt === null) throw conflict('Close the current session before starting another.');
      this.assertNoActiveGames();
      this.resolveAllProposals();
      const previousPlayerIds = includePreviousRoster
        ? this.db.prepare(`SELECT p.id FROM players p WHERE EXISTS (
          SELECT 1 FROM session_players sp WHERE sp.session_id = ? AND sp.player_id = p.id
        )`).pluck().all(this.currentSession().id) as string[] : [];
      const id = randomUUID();
      this.db.prepare('INSERT INTO sessions (id, name, started_at, ended_at) VALUES (?, ?, ?, NULL)')
        .run(id, normalized, nowMs());
      this.db.prepare('UPDATE club_settings SET current_session_id = ? WHERE id = 1').run(id);
      this.db.prepare(`UPDATE players SET attendance = 'expected', location_type = 'holding-pool',
        next_lane = NULL, court_id = NULL, position = 0, waiting_since = NULL`).run();
      this.bumpRotationRevision();
      this.syncSessionPlayers(previousPlayerIds);
      this.audit('session.started', 'session', id, { includePreviousRoster });
      return this.readSnapshot(nowMs());
    }).immediate();
  }

  closeSession(): AppSnapshot {
    return this.db.transaction(() => {
      this.assertNoActiveGames();
      const session = this.currentSession();
      if (session.endedAt === null) {
        this.syncSessionPlayers();
        this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
          .run(Math.max(nowMs(), session.startedAt), session.id);
        this.resolveAllProposals();
        this.bumpRotationRevision();
        this.audit('session.closed', 'session', session.id, {});
      }
      return this.readSnapshot(nowMs());
    }).immediate();
  }

  exportSession(kind: 'attendance' | 'matches', sessionId = this.currentSession().id): string {
    if (kind !== 'attendance' && kind !== 'matches') throw badRequest('Choose attendance or matches.');
    const session = this.db.prepare('SELECT id, name FROM sessions WHERE id = ?').get(sessionId) as
      { id: string; name: string } | undefined;
    if (!session) throw notFound('Session not found.');
    if (kind === 'attendance') {
      const rows = this.db.prepare(`SELECT player_id, name, source, external_id, attendance,
        checked_in_at, games_played, played_seconds FROM session_players
        WHERE session_id = ? ORDER BY name, player_id`).all(session.id) as Array<{
          player_id: string; name: string; source: string | null; external_id: string | null;
          attendance: string; checked_in_at: number | null; games_played: number; played_seconds: number;
        }>;
      return csv([
        ['session_id', 'session_name', 'player_id', 'name', 'source', 'external_id', 'attendance',
          'checked_in_at', 'games_played', 'played_seconds'],
        ...rows.map((row) => [session.id, session.name, row.player_id, row.name, row.source,
          row.external_id, row.attendance, row.checked_in_at === null ? null : new Date(row.checked_in_at).toISOString(),
          row.games_played, row.played_seconds]),
      ]);
    }
    const rows = this.db.prepare(`SELECT * FROM game_history WHERE session_id = ? ORDER BY started_at, rowid`)
      .all(session.id) as HistoryRow[];
    return csv([
      ['session_id', 'session_name', 'match_id', 'court', 'player_ids', 'players', 'team_1', 'team_2',
        'started_at', 'ended_at', 'duration_seconds', 'court_name', 'status', 'reason', 'corrected_at'],
      ...rows.map((row) => {
        const names = parseJsonStringArray(row.player_names_json, 'history');
        const ids = parseJsonStringArray(row.player_ids_json, 'history identity');
        const teamsKnown = ids.length === names.length && ids.length > 0;
        return [session.id, session.name, row.id, row.court_id, row.player_ids_json,
          names.join(' / '), teamsKnown ? names.slice(0, names.length / 2).join(' / ') : '',
          teamsKnown ? names.slice(names.length / 2).join(' / ') : '',
          new Date(row.started_at).toISOString(), new Date(row.ended_at).toISOString(), row.duration,
          row.court_name, row.status, row.reason,
          row.corrected_at === null ? null : new Date(row.corrected_at).toISOString()];
      }),
    ]);
  }

  getSessionReport(sessionId?: string): SessionReport {
    // A report is a consistent, read-only view: do not sync attendance, expire reviews
    // or rewrite historical records while inspecting an archive.
    return this.db.transaction(() => {
      const generatedAt = nowMs();
      const current = this.currentSession();
      const session = this.db.prepare(`SELECT id, name, started_at AS startedAt, ended_at AS endedAt
        FROM sessions WHERE id = ?`).get(sessionId ?? current.id) as Session | undefined;
      if (!session) throw notFound('Session not found.');

      const participants = this.db.prepare(`SELECT player_id AS id, name, source,
        external_id AS externalId, attendance, checked_in_at AS checkedInAt,
        games_played AS gamesPlayed, played_seconds AS playedSeconds FROM session_players
        WHERE session_id = ? ORDER BY name, player_id`).all(session.id) as SessionReport['participants'];
      const matches = (this.db.prepare(`SELECT * FROM game_history
        WHERE session_id = ? ORDER BY started_at, rowid`).all(session.id) as HistoryRow[])
        .map<GameHistory>((row) => ({
          id: row.id, sessionId: row.session_id, courtId: row.court_id,
          courtName: row.court_name ?? `Court ${row.court_id}`,
          players: parseJsonStringArray(row.player_names_json, 'history'),
          playerIds: parseJsonStringArray(row.player_ids_json, 'history identity'),
          startedAt: row.started_at, endedAt: row.ended_at, duration: row.duration,
          status: row.status, reason: row.reason, correctedAt: row.corrected_at,
        }));
      const completed = matches.filter((match) => match.status === 'completed');
      const participantIds = new Set(participants.map((participant) => participant.id));
      const unattributed = completed.filter((match) =>
        (match.playerIds.length !== 2 && match.playerIds.length !== 4)
        || match.playerIds.length !== match.players.length
        || new Set(match.playerIds).size !== match.playerIds.length
        || match.playerIds.some((id) => !participantIds.has(id)));

      return {
        generatedAt,
        displayTimezone: this.getSettings().timezone,
        session,
        participants,
        matches,
        totals: {
          registeredPlayers: participants.length,
          checkedInPlayers: participants.filter((participant) => participant.checkedInAt !== null).length,
          completedMatches: completed.length,
          voidedMatches: matches.length - completed.length,
          correctedMatches: completed.filter((match) => match.correctedAt !== null).length,
          completedCourtSeconds: completed.reduce((seconds, match) => seconds + match.duration, 0),
          unattributedCompletedMatches: unattributed.length,
        },
        activeMatches: session.id === current.id && session.endedAt === null
          ? this.db.prepare("SELECT COUNT(*) FROM courts WHERE status = 'in-play'").pluck().get() as number
          : 0,
      };
    }).deferred();
  }

  getDailyReport(date: string): DailyReport {
    if (typeof date !== 'string' || !isReportDate(date)) throw badRequest('Choose a valid date (YYYY-MM-DD).');
    return this.db.transaction(() => {
      const generatedAt = nowMs();
      const displayTimezone = this.getSettings().timezone;
      const formatter = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
        timeZone: displayTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const onDate = (at: number) => localReportDate(at, formatter) === date;
      // A wide UTC candidate window covers every IANA offset, including DST days.
      // Exact membership is determined by Intl's local calendar date, not a fixed offset.
      const midnight = Date.parse(`${date}T00:00:00.000Z`);
      const from = midnight - 86_400_000;
      const until = midnight + 2 * 86_400_000;
      const sessionIds = new Set<string>();
      const checkedIn = new Set<string>();
      const attendance = this.db.prepare(`SELECT session_id, player_id, checked_in_at
        FROM session_players WHERE checked_in_at >= ? AND checked_in_at < ?`)
        .all(from, until) as Array<{ session_id: string; player_id: string; checked_in_at: number }>;
      for (const entry of attendance) {
        if (!onDate(entry.checked_in_at)) continue;
        checkedIn.add(entry.player_id);
        sessionIds.add(entry.session_id);
      }
      const matches = (this.db.prepare(`SELECT * FROM game_history
        WHERE started_at >= ? AND started_at < ? ORDER BY started_at, id`)
        .all(from, until) as HistoryRow[])
        .filter((row) => onDate(row.started_at))
        .map<GameHistory>((row) => ({
          id: row.id, sessionId: row.session_id, courtId: row.court_id,
          courtName: row.court_name ?? `Court ${row.court_id}`,
          players: parseJsonStringArray(row.player_names_json, 'history'),
          playerIds: parseJsonStringArray(row.player_ids_json, 'history identity'),
          startedAt: row.started_at, endedAt: row.ended_at, duration: row.duration,
          status: row.status, reason: row.reason, correctedAt: row.corrected_at,
        }));
      const totals: DailyReport['totals'] = { checkedInPlayers: checkedIn.size,
        completedMatches: 0, voidedMatches: 0, correctedMatches: 0, completedCourtSeconds: 0 };
      const byCourt = new Map<string, DailyReport['courts'][number]>();
      for (const match of matches) {
        sessionIds.add(match.sessionId);
        const key = JSON.stringify([match.courtId, match.courtName]);
        const court = byCourt.get(key) ?? { courtId: match.courtId, courtName: match.courtName,
          completedMatches: 0, completedCourtSeconds: 0, voidedMatches: 0, correctedMatches: 0 };
        if (match.status === 'voided') {
          totals.voidedMatches += 1;
          court.voidedMatches += 1;
        } else {
          totals.completedMatches += 1;
          totals.completedCourtSeconds += match.duration;
          court.completedMatches += 1;
          court.completedCourtSeconds += match.duration;
          if (match.correctedAt !== null) {
            totals.correctedMatches += 1;
            court.correctedMatches += 1;
          }
        }
        byCourt.set(key, court);
      }
      const sessions = (this.db.prepare(`SELECT id, name, started_at AS startedAt, ended_at AS endedAt
        FROM sessions ORDER BY started_at, id`).all() as Session[])
        .filter((session) => sessionIds.has(session.id) || onDate(session.startedAt));
      return { date, displayTimezone, generatedAt, totals,
        courts: [...byCourt.values()].sort((left, right) => left.courtId - right.courtId
          || left.courtName.localeCompare(right.courtName, 'en-AU')),
        sessions, matches };
    }).deferred();
  }

  seedRecordingFixture(): void {
    const playerCount = this.db.prepare('SELECT COUNT(*) FROM players').pluck().get() as number;
    if (playerCount > 0 || this.currentSession().endedAt !== null) return;

    const seed = this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO players (
          id, name, skill_level, skill_rating, play_style,
          location_type, next_lane, position, court_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      );
      let holdingPosition = 0;
      let nextGamePosition = 0;
      const createdAt = nowMs();

      recordingPlayers.forEach((player, index) => {
        const id = randomUUID();
        const isNextGame = player.location === 'next-game-pool';
        const position = isNextGame ? nextGamePosition++ : holdingPosition++;
        insert.run(
          id,
          player.name,
          player.skillLevel,
          player.skillRating,
          player.playStyle,
          player.location,
          isNextGame ? player.skillLevel : null,
          position,
          createdAt + index,
        );
        this.audit('recording.player.seeded', 'player', id, {
          skillLevel: player.skillLevel,
        });
      });
      this.syncSessionPlayers(this.db.prepare('SELECT id FROM players').pluck().all() as string[]);
      this.syncWaitingIntervals();
      this.bumpRotationRevision();
      this.expirePendingRotationPlans(nowMs());
    });

    seed.immediate();
  }

  /** A complete fictional session ledger, only for a fresh in-memory public board. */
  seedPublicFixture(): void {
    if (this.db.name !== ':memory:') throw conflict('Public records require a temporary board.');
    if ((this.db.prepare('SELECT COUNT(*) FROM players').pluck().get() as number) > 0
      || (this.db.prepare('SELECT COUNT(*) FROM game_history').pluck().get() as number) > 0
      || (this.db.prepare('SELECT COUNT(*) FROM session_players').pluck().get() as number) > 0
      || (this.db.prepare('SELECT COUNT(*) FROM sessions').pluck().get() as number) !== 1
      || this.currentSession().endedAt !== null) return;

    this.db.transaction(() => {
      const at = nowMs();
      const minute = 60_000;
      const current = this.currentSession();
      const opened = at - 95 * minute;
      this.db.prepare('UPDATE sessions SET name = ?, started_at = ? WHERE id = ?')
        .run('Club social', opened, current.id);
      this.db.prepare(`UPDATE club_settings SET venue_name = ?, court_count = ?, court_names_json = ? WHERE id = 1`)
        .run('Sidecourt', PUBLIC_COURT_COUNT, JSON.stringify(publicCourtNames));
      const profiles = publicRoster.map((player) => ({ ...player, id: randomUUID() }));
      const insertPlayer = this.db.prepare(`INSERT INTO players
        (id,name,skill_level,skill_rating,play_style,attendance,source,external_id,
         location_type,next_lane,position,court_id,created_at,waiting_since)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      let holdingPosition = 0;
      profiles.forEach((player, index) => {
        const onCourt = index < 40;
        const staged = index >= 40 && index < 44;
        const attendance: Attendance = index >= 92 ? 'departed' : index >= 84 ? 'expected'
          : index >= 76 ? 'resting' : 'ready';
        const waiting = !onCourt && attendance === 'ready';
        insertPlayer.run(player.id, player.name, player.skillLevel, player.skillRating, player.playStyle,
          attendance, 'club roster', player.externalId,
          onCourt ? 'court' : staged ? 'next-game-pool' : 'holding-pool',
          staged ? 'intermediate' : null, onCourt ? [0, 2, 3, 1][index % 4]! : staged ? index - 40 : holdingPosition++,
          onCourt ? Math.floor(index / 4) + 1 : null, opened - 15 * minute + index * 300,
          waiting ? at - (staged ? 20 * minute : index < 72 ? 18 * minute - (index - 44) * 12_000 : 10 * minute - (index - 72) * minute) : null);
      });

      const insertParticipant = this.db.prepare(`INSERT INTO session_players
        (session_id,player_id,name,source,external_id,attendance,checked_in_at,games_played,played_seconds)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      const insertMatch = this.db.prepare(`INSERT INTO game_history
        (id,session_id,court_id,court_name,player_names_json,player_ids_json,started_at,ended_at,
         duration,status,reason,corrected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      const seedLedger = (sessionId: string, start: number, rounds: number, archive: boolean) => {
        // The current late arrivals have no match history before their check-in.
        const eligible = profiles.filter((_, index) => (index < 84 || index >= 92)
          && (archive || index < 72 || index >= 76));
        const stats = new Map<string, { games: number; seconds: number }>();
        for (let round = 0; round < rounds; round += 1) {
          for (let court = 0; court < PUBLIC_COURT_COUNT; court += 1) {
            // Coprime strides keep each round unique while varying groups between rounds.
            const stride = [1, 5, 13, 17][round]!;
            const quartet = Array.from({ length: 4 }, (_, seat) => eligible[(round * 48 + (court * 4 + seat) * stride) % eligible.length]!);
            const orders = [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2]];
            const order = quartet.every((player) => player.skillRating !== null)
              ? orders.reduce((best, candidate) => {
                const difference = (seats: number[]) => Math.abs(seats.reduce((sum, seat, index) =>
                  sum + (index < 2 ? 1 : -1) * quartet[seat]!.skillRating!, 0));
                return difference(candidate) < difference(best) ? candidate : best;
              }) : orders[round % orders.length]!;
            const players = order.map((seat) => quartet[seat]!);
            const startedAt = start + (15 + round * 20) * minute;
            const seconds = (12 + (round + court) % 7) * 60;
            const endedAt = startedAt + seconds * 1000;
            const corrected = !archive && round === 0 && court === 2;
            insertMatch.run(randomUUID(), sessionId, court + 1, publicCourtNames[court],
              JSON.stringify(players.map((player) => player.name)), JSON.stringify(players.map((player) => player.id)),
              startedAt, endedAt, seconds, 'completed', corrected ? 'Corrected timer after a missed stop.' : null,
              corrected ? at - 19 * minute : null);
            for (const player of players) {
              const previous = stats.get(player.id) ?? { games: 0, seconds: 0 };
              stats.set(player.id, { games: previous.games + 1, seconds: previous.seconds + seconds });
            }
          }
        }
        if (!archive) {
          const players = profiles.slice(0, 4);
          const startedAt = at - 20 * minute;
          insertMatch.run(randomUUID(), sessionId, 11, publicCourtNames[10],
            JSON.stringify(players.map((player) => player.name)), JSON.stringify(players.map((player) => player.id)),
            startedAt, startedAt + 35_000, 35, 'voided', 'Accidental start; players had not begun play.', startedAt + 35_000);
        }
        profiles.forEach((player, index) => {
          const expected = index >= 84 && index < 92;
          const attendance: Attendance = expected ? 'expected' : archive || index >= 92 ? 'departed'
            : index >= 76 && index < 84 ? 'resting' : 'ready';
          const checkedInAt = expected ? null : !archive && index >= 72 && index < 76
            ? at - (12 - (index - 72)) * minute : start + (index % 10 - 5) * minute;
          const totals = stats.get(player.id) ?? { games: 0, seconds: 0 };
          insertParticipant.run(sessionId, player.id, player.name, 'club roster', player.externalId,
            attendance, checkedInAt, totals.games, totals.seconds);
        });
      };

      // Dated, closed records demonstrate the existing archive/report workflow.
      for (const [daysAgo, name, rounds] of [[7, 'Evening social', 4], [3, 'Morning social', 3]] as const) {
        const id = randomUUID();
        const start = opened - daysAgo * 24 * 60 * minute;
        this.db.prepare('INSERT INTO sessions (id,name,started_at,ended_at) VALUES (?,?,?,?)')
          .run(id, name, start, start + 120 * minute);
        seedLedger(id, start, rounds, true);
      }
      seedLedger(current.id, opened, 3, false);
      for (let courtId = 1; courtId <= 8; courtId += 1) {
        this.db.prepare("UPDATE courts SET status = 'in-play', game_started_at = ? WHERE id = ?")
          .run(at - (3 + courtId) * minute, courtId);
      }
      this.bumpRotationRevision();
      this.audit('public.fixture.created', 'session', current.id,
        { players: profiles.length, courts: PUBLIC_COURT_COUNT, provenance: 'fictional' });
    }).immediate();
  }

  createPlayer(values: CreatePlayerValues): AppSnapshot {
    if (!values || typeof values.name !== 'string' || !values.name.trim() || values.name.trim().length > 80
      || !isSkillLevel(values.skillLevel) || !isPlayStyle(values.playStyle)
      || (values.skillRating !== null && (!Number.isFinite(values.skillRating)
        || values.skillRating < 1 || values.skillRating > 6))) throw badRequest('Invalid player details.');
    return this.mutate(() => {
      const position = this.containerIds('holding-pool').length;
      const id = randomUUID();
      this.db.prepare(
        `INSERT INTO players (
          id, name, skill_level, skill_rating, play_style,
          location_type, next_lane, position, court_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'holding-pool', NULL, ?, NULL, ?)`,
      ).run(
        id,
        values.name.trim(),
        values.skillLevel,
        values.skillRating,
        values.playStyle,
        position,
        nowMs(),
      );
      this.syncSessionPlayers([id]);
      this.audit('player.created', 'player', id, { skillLevel: values.skillLevel });
    });
  }

  removePlayer(playerId: string): AppSnapshot {
    return this.mutate(() => {
      const player = this.requirePlayerRow(playerId);
      this.assertPlayerRosterUnlocked(player);
      this.detachPlayer(player);
      this.db.prepare(`UPDATE session_players SET attendance = 'departed'
        WHERE session_id = ? AND player_id = ?`).run(this.currentSession().id, playerId);
      this.db.prepare('DELETE FROM players WHERE id = ?').run(playerId);
      this.audit('player.removed', 'player', playerId, {});
    });
  }

  previewRosterImport(source: string, rows: RosterImportRow[]): RosterImportPreview {
    const normalized = this.normalizeRosterImport(source, rows);
    return this.db.transaction(() => this.readRosterImportPreview(normalized)).deferred();
  }

  importRoster(source: string, rows: RosterImportRow[], options: {
    updateExisting?: boolean | undefined;
    revision?: number | undefined;
  } = {}): {
    snapshot: AppSnapshot;
    added: number;
    skipped: number;
    updated: number;
    enrolled: number;
  } {
    return this.db.transaction(() => {
      this.assertSessionOpen();
      if (!options || typeof options !== 'object'
        || (options.updateExisting !== undefined && typeof options.updateExisting !== 'boolean')
        || (options.revision !== undefined && (!Number.isSafeInteger(options.revision) || options.revision < 0))) {
        throw badRequest('Invalid roster import review options.');
      }
      const normalized = this.normalizeRosterImport(source, rows);
      const preview = this.readRosterImportPreview(normalized);
      if (options.updateExisting && options.revision !== preview.revision) {
        throw conflict('The session changed after this roster preview. Review the import again.');
      }
      if (preview.conflictCount > 0 && (!options.updateExisting
        || preview.rows.some((row) => row.status === 'conflict' && !row.canUpdate))) {
        throw conflict('The import conflicts with existing roster details. No players were imported.');
      }
      const insert = this.db.prepare(
        `INSERT INTO players (
          id, name, skill_level, skill_rating, play_style, attendance, source, external_id,
          location_type, next_lane, position, court_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'expected', ?, ?, 'holding-pool', NULL, 0, NULL, ?)`,
      );
      const update = this.db.prepare(`UPDATE players SET name = ?, skill_level = ?,
        skill_rating = ?, play_style = ? WHERE id = ?`);
      const createdAt = nowMs();
      const submittedIds: string[] = [];
      let updated = 0;
      let skipped = 0;
      preview.rows.forEach((row, index) => {
        if (row.status === 'new') {
          const id = randomUUID();
          insert.run(id, row.name, row.skillLevel, row.skillRating, row.playStyle,
            preview.source, row.externalId, createdAt + index);
          submittedIds.push(id);
          return;
        }
        const [existing] = this.rosterIdentityRows(preview.source, row.externalId);
        if (!existing) throw conflict('The roster changed. Review the import again.');
        submittedIds.push(existing.id);
        if (row.status === 'conflict') {
          update.run(row.name, row.skillLevel, row.skillRating, row.playStyle, existing.id);
          updated += 1;
          this.audit('roster.profile.updated', 'player', existing.id, {
            source: preview.source, externalId: row.externalId,
            before: row.current,
            after: { name: row.name, skillLevel: row.skillLevel, skillRating: row.skillRating, playStyle: row.playStyle },
          });
        } else if (this.isCurrentSessionMember(existing.id)) {
          skipped += 1;
        }
      });
      const changed = preview.newCount > 0 || updated > 0 || preview.enrollCount > 0;
      if (changed) {
        this.audit('roster.imported', 'roster', null, {
          added: preview.newCount, skipped, updated, enrolled: preview.enrollCount,
        });
        this.syncSessionPlayers(submittedIds);
        this.bumpRotationRevision();
        this.expirePendingRotationPlans(createdAt);
      }
      return {
        snapshot: this.readSnapshot(nowMs()),
        added: preview.newCount,
        skipped,
        updated,
        enrolled: preview.enrollCount,
      };
    }).immediate();
  }

  setAttendance(playerId: string, attendance: Attendance): AppSnapshot {
    if (!attendanceStatuses.includes(attendance)) throw badRequest('Invalid attendance status.');
    return this.mutate(() => {
      const player = this.requirePlayerRow(playerId);
      if (player.attendance === attendance) return;
      this.assertPlayerRosterUnlocked(player);
      this.detachPlayer(player);
      const position = attendance === 'ready' ? this.containerIds('holding-pool').length : 0;
      this.db.prepare(
        `UPDATE players SET attendance = ?, location_type = 'holding-pool',
         next_lane = NULL, court_id = NULL, position = ? WHERE id = ?`,
      ).run(attendance, position, playerId);
      this.audit('player.attendance.changed', 'player', playerId, { attendance });
    });
  }

  movePlayer(playerId: string, destination: Destination): AppSnapshot {
    return this.mutate(() => {
      const player = this.requirePlayerRow(playerId);
      this.assertPlayerReady(player);
      this.assertPlayerRosterUnlocked(player);

      if (
        destination.type === 'court'
        && player.location_type === 'court'
        && player.court_id === destination.courtId
      ) {
        return;
      }
      if (
        destination.type === 'next-game-pool'
        && player.location_type === 'next-game-pool'
        && player.next_lane === destination.lane
      ) {
        return;
      }
      if (
        destination.type === 'holding-pool'
        && (destination.index === undefined || destination.index === player.position)
        && player.location_type === 'holding-pool'
      ) {
        return;
      }

      if (destination.type === 'court') {
        const court = this.requireCourt(destination.courtId);
        if (court.status !== 'available') {
          throw conflict('Players can only be assigned to an available court.');
        }
        if (this.containerIds('court', undefined, destination.courtId).length >= this.groupSize()) {
          throw conflict('The selected court is full for this game mode.');
        }
      }
      if (destination.type === 'next-game-pool') {
        if (!queueLanes.includes(destination.lane)) throw badRequest('Choose a valid staging lane.');
        if (player.skill_level === 'unrated' && destination.lane !== 'mixed') {
          throw badRequest('Unrated players use the mixed staging lane.');
        }
      }

      this.detachPlayer(player);

      if (destination.type === 'holding-pool') {
        const ids = this.containerIds('holding-pool').filter((id) => id !== playerId);
        const targetIndex = destination.index ?? ids.length;
        if (targetIndex > ids.length) {
          throw badRequest('Holding-pool index is outside the current queue.');
        }
        ids.splice(targetIndex, 0, playerId);
        this.db.prepare(
          `UPDATE players
           SET location_type = 'holding-pool', next_lane = NULL, court_id = NULL
           WHERE id = ?`,
        ).run(playerId);
        this.rewritePositions(ids);
      } else if (destination.type === 'next-game-pool') {
        const ids = this.containerIds('next-game-pool', destination.lane);
        ids.push(playerId);
        this.db.prepare(
          `UPDATE players
           SET location_type = 'next-game-pool', next_lane = ?, court_id = NULL
           WHERE id = ?`,
        ).run(destination.lane, playerId);
        this.rewritePositions(ids);
      } else {
        const ids = this.containerIds('court', undefined, destination.courtId);
        const position = ids.length;
        this.db.prepare(
          `UPDATE players
           SET location_type = 'court', next_lane = NULL, court_id = ?, position = ?
           WHERE id = ?`,
        ).run(destination.courtId, position, playerId);
      }

      this.audit('player.moved', 'player', playerId, {
        origin: player.location_type, originIndex: player.position,
        originCourtId: player.court_id ?? 0, originLane: player.next_lane ?? '',
        destination: destination.type,
        destinationIndex: this.requirePlayerRow(playerId).position,
        destinationCourtId: destination.type === 'court' ? destination.courtId : 0,
        destinationLane: destination.type === 'next-game-pool' ? destination.lane : '',
      });
    });
  }

  assignStagedGroup(
    courtId: number,
    sessionId: string,
    lane: QueueLane,
    playerIds: string[],
    approveMixed = false,
  ): AppSnapshot {
    return this.mutate(() => {
      if (this.currentSession().id !== sessionId) {
        throw conflict('The session changed. Review the staged group again.');
      }
      if (!queueLanes.includes(lane) || typeof approveMixed !== 'boolean') {
        throw badRequest('Choose a valid staging lane and mixed-level approval.');
      }
      const size = this.groupSize();
      if (!Array.isArray(playerIds) || playerIds.length !== size || new Set(playerIds).size !== size) {
        throw badRequest(`A staged group must contain exactly ${size} unique players.`);
      }
      const court = this.requireCourt(courtId);
      if (court.status !== 'available') throw conflict('Choose an empty, available court.');
      const assigned = this.playerRowsForCourt(courtId);
      if (assigned.length > 0) {
        // An audit record binds a retry to this assignment, rather than a manually assembled court.
        const previous = this.db.prepare(`SELECT metadata_json FROM audit_log
          WHERE action = 'staged_group.assigned' AND entity_type = 'court' AND entity_id = ?
          ORDER BY rowid DESC LIMIT 1`).get(String(courtId)) as { metadata_json: string } | undefined;
        const metadata: unknown = previous ? JSON.parse(previous.metadata_json) : null;
        const retry = { sessionId, courtId, lane, playerIds, approveMixed };
        if (assigned.length === size && assigned.every((player, index) =>
          player.id === playerIds[index] && player.attendance === 'ready')
          && JSON.stringify(metadata) === JSON.stringify(retry)) return;
        throw conflict('Choose an empty, available court.');
      }

      // Lanes store an ordered queue, not durable proposal groups. Bind to its current first group.
      const stagedIds = this.containerIds('next-game-pool', lane);
      const expected = stagedIds.slice(0, size);
      const players = this.playerRowsByIds(playerIds);
      if (expected.length !== size || expected.some((id, index) => id !== playerIds[index])
        || players.length !== size || players.some((player) => player.attendance !== 'ready'
          || player.location_type !== 'next-game-pool' || player.next_lane !== lane)) {
        throw conflict('The staged group changed. Review the first group in this lane again.');
      }
      if (this.getSettings().rotationMode === 'skill-banded'
        && new Set(players.map((player) => player.skill_level)).size > 1 && !approveMixed) {
        throw conflict('Approve mixed levels before assigning this group.');
      }

      const moveToCourt = this.db.prepare(`UPDATE players SET location_type = 'court',
        next_lane = NULL, court_id = ?, position = ? WHERE id = ?`);
      playerIds.forEach((playerId, position) => moveToCourt.run(courtId, position, playerId));
      this.rewritePositions(stagedIds.slice(size));
      this.audit('staged_group.assigned', 'court', String(courtId), {
        sessionId, courtId, lane, playerIds, approveMixed,
      });
    });
  }

  reorderHoldingPool(playerId: string, targetIndex: number): AppSnapshot {
    return this.mutate(() => {
      const player = this.requirePlayerRow(playerId);
      this.assertPlayerReady(player);
      if (player.location_type !== 'holding-pool') {
        throw conflict('Only players in the holding pool can be reordered.');
      }
      const ids = this.containerIds('holding-pool');
      if (targetIndex < 0 || targetIndex >= ids.length) {
        throw badRequest('Holding-pool index is outside the current queue.');
      }
      const currentIndex = ids.indexOf(playerId);
      if (currentIndex < 0) throw new Error('Stored holding-pool position is inconsistent.');
      if (currentIndex === targetIndex) return;
      ids.splice(currentIndex, 1);
      ids.splice(targetIndex, 0, playerId);
      this.rewritePositions(ids);
      this.audit('holding.reordered', 'player', playerId, { originIndex: currentIndex, targetIndex });
    });
  }

  startGame(courtId: number): AppSnapshot {
    return this.mutate(() => {
      const court = this.requireCourt(courtId);
      if (court.status === 'disabled') throw conflict('The selected court is disabled.');
      if (court.status === 'in-play') throw conflict('A game is already in progress on this court.');
      const players = this.playerRowsForCourt(courtId);
      for (const player of players) this.assertPlayerReady(player);
      const playerCount = players.length;
      if (playerCount !== this.groupSize()) {
        throw conflict(`A ${this.getSettings().gameMode} game requires exactly ${this.groupSize()} assigned players.`);
      }
      const startedAt = nowMs();
      this.db.prepare(
        `UPDATE courts SET status = 'in-play', game_started_at = ? WHERE id = ?`,
      ).run(startedAt, courtId);
      this.audit('game.started', 'court', String(courtId), { playerCount });
    });
  }

  endGame(courtId: number): AppSnapshot {
    return this.mutate(() => {
      const court = this.requireCourt(courtId);
      if (court.status !== 'in-play' || court.game_started_at === null) {
        throw conflict('No game is in progress on this court.');
      }

      const players = this.playerRowsForCourt(courtId);
      if (players.length !== 2 && players.length !== 4) {
        throw conflict('The active game roster is invalid and cannot be completed safely.');
      }
      const endedAt = Math.max(nowMs(), court.game_started_at);
      const duration = Math.floor((endedAt - court.game_started_at) / 1000);
      const historyId = randomUUID();
      this.db.prepare(
        `INSERT INTO game_history (
          id, court_id, player_names_json, started_at, ended_at, duration, session_id, player_ids_json, court_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        historyId,
        courtId,
        JSON.stringify(players.map((player) => player.name)),
        court.game_started_at,
        endedAt,
        duration,
        this.currentSession().id,
        JSON.stringify(players.map((player) => player.id)),
        this.getSettings().courtNames[courtId - 1]!,
      );
      const recordGame = this.db.prepare(`UPDATE session_players SET games_played = games_played + 1,
        played_seconds = played_seconds + ? WHERE session_id = ? AND player_id = ?`);
      for (const player of players) recordGame.run(duration, this.currentSession().id, player.id);

      const holdingIds = this.containerIds('holding-pool');
      for (const player of players) holdingIds.push(player.id);
      const moveToHolding = this.db.prepare(
        `UPDATE players
         SET location_type = 'holding-pool', next_lane = NULL, court_id = NULL
         WHERE id = ?`,
      );
      for (const player of players) moveToHolding.run(player.id);
      this.rewritePositions(holdingIds);
      this.db.prepare(
        `UPDATE courts SET status = 'available', game_started_at = NULL WHERE id = ?`,
      ).run(courtId);
      this.audit('game.ended', 'game_history', historyId, { courtId, playerCount: players.length });
    });
  }

  voidActiveGame(courtId: number, reason: string): AppSnapshot {
    const normalized = this.normalizeReason(reason);
    return this.mutate(() => {
      const court = this.requireCourt(courtId);
      if (court.status !== 'in-play' || court.game_started_at === null) throw conflict('No game is in progress on this court.');
      const players = this.playerRowsForCourt(courtId);
      if (players.length !== 2 && players.length !== 4) throw conflict('The active game roster is invalid.');
      const endedAt = Math.max(nowMs(), court.game_started_at);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO game_history (id,court_id,player_names_json,started_at,ended_at,duration,
        session_id,player_ids_json,court_name,status,reason,corrected_at)
        VALUES (?,?,?,?,?,?,?,?,?,'voided',?,?)`).run(id, courtId,
        JSON.stringify(players.map((player) => player.name)), court.game_started_at, endedAt,
        Math.floor((endedAt - court.game_started_at) / 1000), this.currentSession().id,
        JSON.stringify(players.map((player) => player.id)), this.getSettings().courtNames[courtId - 1]!, normalized, endedAt);
      this.db.prepare("UPDATE courts SET status = 'available', game_started_at = NULL WHERE id = ?").run(courtId);
      this.resolveAllProposals();
      this.audit('game.voided.active', 'game_history', id, { courtId, reason: normalized,
        playerIds: players.map((player) => player.id), previousStatus: 'in-play', status: 'voided' });
    });
  }

  voidRecordedGame(gameId: string, reason: string): AppSnapshot {
    const normalized = this.normalizeReason(reason);
    return this.mutate(() => {
      const game = this.requireEditableHistory(gameId);
      if (game.status === 'voided') return;
      const correctedAt = nowMs();
      this.db.prepare("UPDATE game_history SET status = 'voided', reason = ?, corrected_at = ? WHERE id = ?")
        .run(normalized, correctedAt, gameId);
      this.recalculateSessionStats();
      this.resolveAllProposals();
      this.audit('game.voided.recorded', 'game_history', gameId,
        { reason: normalized, before: this.historyAuditValue(game), after: { status: 'voided', correctedAt } });
    });
  }

  correctRecordedGame(gameId: string, correction: {
    playerIds: string[]; durationSeconds: number; reason: string;
  }): AppSnapshot {
    const reason = this.normalizeReason(correction?.reason);
    return this.mutate(() => {
      const game = this.requireEditableHistory(gameId);
      if (game.status !== 'completed') throw conflict('A voided game cannot be corrected.');
      const originalIds = parseJsonStringArray(game.player_ids_json, 'history identity');
      const size = originalIds.length;
      if ((size !== 2 && size !== 4) || !Array.isArray(correction.playerIds)
        || correction.playerIds.length !== size || new Set(correction.playerIds).size !== size
        || correction.playerIds.some((id) => typeof id !== 'string')
        || !Number.isInteger(correction.durationSeconds) || correction.durationSeconds < 0
        || correction.durationSeconds > 86_400) throw badRequest('Choose the original group size and a valid duration.');
      const endedAt = game.started_at + correction.durationSeconds * 1000;
      if (endedAt > nowMs()) throw badRequest('The corrected finish time cannot be in the future.');
      const findIdentity = this.db.prepare('SELECT name FROM session_players WHERE session_id = ? AND player_id = ?');
      const identities = correction.playerIds.map((id) => findIdentity.get(game.session_id, id) as { name: string } | undefined);
      if (identities.some((identity) => !identity)) throw badRequest('Choose participants recorded in this session.');
      const names = identities.map((identity) => identity!.name);
      const idsJson = JSON.stringify(correction.playerIds);
      const namesJson = JSON.stringify(names);
      if (game.player_ids_json === idsJson && game.player_names_json === namesJson
        && game.duration === correction.durationSeconds && game.reason === reason) return;
      const correctedAt = nowMs();
      this.db.prepare(`UPDATE game_history SET player_ids_json = ?, player_names_json = ?, duration = ?,
        ended_at = ?, reason = ?, corrected_at = ? WHERE id = ?`)
        .run(idsJson, namesJson, correction.durationSeconds, endedAt, reason, correctedAt, gameId);
      this.recalculateSessionStats();
      this.resolveAllProposals();
      this.audit('game.corrected', 'game_history', gameId,
        { reason, before: this.historyAuditValue(game), after: { playerIds: correction.playerIds,
          players: names, duration: correction.durationSeconds, endedAt, correctedAt } });
    });
  }

  private normalizeReason(reason: string): string {
    const normalized = typeof reason === 'string' ? reason.trim() : '';
    if (normalized.length < 3 || normalized.length > 160) throw badRequest('A reason must contain 3 to 160 characters.');
    return normalized;
  }

  private requireEditableHistory(gameId: string): HistoryRow {
    const game = this.db.prepare('SELECT * FROM game_history WHERE id = ?').get(gameId) as HistoryRow | undefined;
    if (!game) throw notFound('Game record not found.');
    if (game.session_id !== this.currentSession().id || this.currentSession().endedAt !== null) {
      throw conflict('Closed session records are read-only.');
    }
    return game;
  }

  private historyAuditValue(game: HistoryRow): Record<string, unknown> {
    return { playerIds: parseJsonStringArray(game.player_ids_json, 'history identity'),
      players: parseJsonStringArray(game.player_names_json, 'history'), duration: game.duration,
      endedAt: game.ended_at, status: game.status, reason: game.reason, correctedAt: game.corrected_at };
  }

  private recalculateSessionStats(): void {
    const sessionId = this.currentSession().id;
    this.db.prepare('UPDATE session_players SET games_played = 0, played_seconds = 0 WHERE session_id = ?').run(sessionId);
    const games = this.db.prepare("SELECT player_ids_json, duration FROM game_history WHERE session_id = ? AND status = 'completed'")
      .all(sessionId) as Array<Pick<HistoryRow, 'player_ids_json' | 'duration'>>;
    const increment = this.db.prepare(`UPDATE session_players SET games_played = games_played + 1,
      played_seconds = played_seconds + ? WHERE session_id = ? AND player_id = ?`);
    for (const game of games) {
      const ids = parseJsonStringArray(game.player_ids_json, 'history identity');
      if ((ids.length !== 2 && ids.length !== 4) || new Set(ids).size !== ids.length) continue;
      for (const id of ids) increment.run(game.duration, sessionId, id);
    }
  }

  toggleCourtStatus(courtId: number): AppSnapshot {
    return this.mutate(() => {
      const court = this.requireCourt(courtId);
      if (court.status === 'in-play') {
        throw conflict('An in-progress court cannot be disabled. End the game first.');
      }

      const nextStatus: CourtStatus = court.status === 'disabled' ? 'available' : 'disabled';
      let returnedPlayers = 0;
      if (nextStatus === 'disabled') {
        const players = this.playerRowsForCourt(courtId);
        returnedPlayers = players.length;
        const holdingIds = this.containerIds('holding-pool');
        const moveToHolding = this.db.prepare(
          `UPDATE players
           SET location_type = 'holding-pool', next_lane = NULL, court_id = NULL
           WHERE id = ?`,
        );
        for (const player of players) {
          moveToHolding.run(player.id);
          holdingIds.push(player.id);
        }
        this.rewritePositions(holdingIds);
      }

      this.db.prepare(
        `UPDATE courts SET status = ?, game_started_at = NULL WHERE id = ?`,
      ).run(nextStatus, courtId);
      this.audit('court.toggled', 'court', String(courtId), { status: nextStatus, returnedPlayers });
    });
  }

  getHoldingCandidates(): HoldingCandidate[] {
    return this.getMatchContext().candidates;
  }

  getMatchContext(allowMixed = false): {
    candidates: HoldingCandidate[]; previousTeams: string[][]; mixed: boolean; revision: number;
  } {
    this.assertSessionOpen();
    const selection = this.rotationSelection();
    let ids = selection.eligiblePlayerIds;
    let mixed = false;
    if (selection.waitingBand !== null && selection.missingPlayers > 0) {
      if (!allowMixed || !selection.needsMixedApproval) {
        throw new AppError(409, 'BAND_INCOMPLETE', `Waiting for ${selection.missingPlayers} ${selection.waitingBand} players.`);
      }
      ids = this.containerIds('holding-pool').slice(0, this.groupSize());
      mixed = true;
    }
    const byId = new Map(this.playerRowsByIds(ids).map((row) => [row.id, row]));
    const candidates = ids.map((id) => byId.get(id)!).map((row) => ({
      id: row.id,
      skillLevel: parseSkillLevel(row.skill_level),
      skillRating: row.skill_rating,
      playStyle: parsePlayStyle(row.play_style),
      createdAt: row.created_at,
    }));
    const games = this.db.prepare(`SELECT player_ids_json FROM game_history
      WHERE session_id = ? AND status = 'completed' ORDER BY started_at, rowid`)
      .all(this.currentSession().id) as Array<{ player_ids_json: string }>;
    const previousTeams = games.flatMap((game) => {
      const gameIds = parseJsonStringArray(game.player_ids_json, 'history identity');
      return gameIds.length === 4 && new Set(gameIds).size === 4 ? [gameIds.slice(0, 2), gameIds.slice(2)] : [];
    });
    return { candidates, previousTeams, mixed, revision: this.rotationRevision() };
  }

  private rotationSelection(): AppSnapshot['rotation'] {
    const size = this.groupSize();
    const ids = this.containerIds('holding-pool');
    const byId = new Map(this.playerRowsByIds(ids).map((row) => [row.id, row]));
    const waitingBand = this.getSettings().rotationMode === 'skill-banded' && ids.length > 0
      ? parseSkillLevel(byId.get(ids[0]!)!.skill_level) : null;
    const eligible = waitingBand === null ? ids.slice(0, size)
      : ids.filter((id) => byId.get(id)!.skill_level === waitingBand).slice(0, size);
    const missingPlayers = Math.max(0, size - eligible.length);
    return { requiredPlayers: size, eligiblePlayerIds: eligible, waitingBand, missingPlayers,
      needsMixedApproval: waitingBand !== null && missingPlayers > 0 && ids.length >= size };
  }

  createRotationPlan(allowMixed = false): RotationPlan {
    if (typeof allowMixed !== 'boolean') throw badRequest('Choose whether mixed levels may be previewed.');
    return this.db.transaction(() => {
      this.assertSessionOpen();
      const createdAt = nowMs();
      this.expirePendingRotationPlans(createdAt);
      const session = this.currentSession();
      this.db.prepare(`UPDATE rotation_plans SET status = 'rejected', resolved_at = ?
        WHERE session_id = ? AND status = 'pending'`).run(createdAt, session.id);

      const snapshot = this.readSnapshot(createdAt);
      const settings = snapshot.settings;
      const courts = snapshot.courts
        .filter((court) => court.status === 'available' && court.players.length === 0)
        .map((court) => ({ id: court.id, name: court.name }));
      const result = buildRotationAssignments(
        snapshot.holdingPool,
        courts,
        settings.gameMode,
        settings.rotationMode,
        allowMixed,
        settings.avoidRepeatPartners,
        snapshot.gameHistory.filter((game) => game.status === 'completed'),
      );
      const storedAssignments = this.storeRotationAssignments(result.assignments);
      const id = randomUUID();
      const revision = this.rotationRevision();
      const expiresAt = createdAt + ROTATION_PLAN_TTL_MS;
      this.db.prepare(`INSERT INTO rotation_plans (
        id, session_id, revision, created_at, expires_at, status,
        allow_mixed, can_mix, rotation_mode, avoid_repeat_partners,
        assignments_json, waiting_player_ids_json, blocked_reason, resolved_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        id,
        session.id,
        revision,
        createdAt,
        expiresAt,
        allowMixed ? 1 : 0,
        result.canMix ? 1 : 0,
        settings.rotationMode,
        settings.avoidRepeatPartners ? 1 : 0,
        JSON.stringify(storedAssignments),
        JSON.stringify(result.waiting.map((player) => player.id)),
        result.blockedReason,
      );
      this.audit('rotation_plan.created', 'rotation_plan', id, {
        sessionId: session.id,
        revision,
        allowMixed,
        canMix: result.canMix,
        assignmentCount: result.assignments.length,
        playerCount: storedAssignments.reduce((count, assignment) => count + assignment.playerIds.length, 0),
        blockedReason: result.blockedReason ?? '',
      });
      this.pruneRotationPlans();
      return {
        id,
        sessionId: session.id,
        revision,
        createdAt,
        expiresAt,
        status: 'pending' as const,
        allowMixed,
        canMix: result.canMix,
        policy: {
          rotationMode: settings.rotationMode,
          avoidRepeatPartners: settings.avoidRepeatPartners,
        },
        assignments: result.assignments,
        waiting: result.waiting,
        blockedReason: result.blockedReason,
      };
    }).immediate();
  }

  getCurrentRotationPlan(): RotationPlan | null {
    return this.db.transaction(() => {
      const at = nowMs();
      this.expirePendingRotationPlans(at);
      const session = this.currentSession();
      const row = this.db.prepare(`SELECT * FROM rotation_plans
        WHERE session_id = ? AND status = 'pending'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(session.id) as RotationPlanRow | undefined;
      if (!row) return null;
      if (row.revision !== this.rotationRevision()) {
        this.db.prepare(`UPDATE rotation_plans SET status = 'expired', resolved_at = ?
          WHERE id = ? AND status = 'pending'`).run(at, row.id);
        return null;
      }
      return this.mapRotationPlan(row);
    }).immediate();
  }

  rejectRotationPlan(planId: string): Pick<RotationPlan, 'id' | 'status'> {
    return this.db.transaction(() => {
      const at = nowMs();
      this.expirePendingRotationPlans(at);
      const row = this.requireRotationPlan(planId);
      if (row.status === 'applied') {
        throw conflict('An applied rotation plan cannot be dismissed.');
      }
      if (row.status === 'pending') {
        this.db.prepare(`UPDATE rotation_plans SET status = 'rejected', resolved_at = ?
          WHERE id = ? AND status = 'pending'`).run(at, row.id);
        this.audit('rotation_plan.rejected', 'rotation_plan', row.id, {
          sessionId: row.session_id,
          reviewedRevision: row.revision,
          reason: 'operator-dismissed-review',
        });
      }
      const rejected = this.requireRotationPlan(planId);
      return { id: rejected.id, status: rejected.status };
    }).immediate();
  }

  applyRotationPlan(planId: string, approveMixed = false): RotationPlan {
    if (typeof approveMixed !== 'boolean') throw badRequest('Choose whether mixed levels are approved.');
    return this.db.transaction(() => {
      const at = nowMs();
      this.expirePendingRotationPlans(at);
      const row = this.requireRotationPlan(planId);
      const assignments = this.parseStoredRotationAssignments(row.assignments_json);

      if (row.status === 'applied') {
        if (this.rotationRevision() !== row.revision + 1
          || !this.rotationAssignmentsRemainIntact(assignments)) {
          throw conflict('This rotation was already applied and the board has since changed.');
        }
        return this.mapRotationPlan(row);
      }
      if (row.status !== 'pending') throw conflict(`This rotation plan is ${row.status}.`);
      if (assignments.length === 0) throw conflict('This rotation plan has no assignments to apply.');

      const session = this.currentSession();
      const settings = this.getSettings();
      if (session.endedAt !== null || row.session_id !== session.id || row.revision !== this.rotationRevision()) {
        throw conflict('The board changed. Review the rotation again.');
      }
      if (row.rotation_mode !== settings.rotationMode
        || Boolean(row.avoid_repeat_partners) !== settings.avoidRepeatPartners) {
        throw conflict('The rotation policy changed. Review the rotation again.');
      }
      const requiresMixedApproval = row.rotation_mode === 'skill-banded'
        && assignments.some((assignment) => assignment.mixed);
      if (requiresMixedApproval && (!row.allow_mixed || !approveMixed)) {
        throw conflict('Approve mixed levels before applying this rotation.');
      }

      const snapshot = this.readSnapshot(at);
      const courts = snapshot.courts
        .filter((court) => court.status === 'available' && court.players.length === 0)
        .map((court) => ({ id: court.id, name: court.name }));
      const recomputed = buildRotationAssignments(
        snapshot.holdingPool,
        courts,
        settings.gameMode,
        settings.rotationMode,
        row.allow_mixed === 1,
        settings.avoidRepeatPartners,
        snapshot.gameHistory.filter((game) => game.status === 'completed'),
      );
      const recomputedAssignments = this.storeRotationAssignments(recomputed.assignments);
      const waitingIds = parseJsonStringArray(row.waiting_player_ids_json, 'rotation waiting');
      if (JSON.stringify(recomputedAssignments) !== JSON.stringify(assignments)
        || JSON.stringify(recomputed.waiting.map((player) => player.id)) !== JSON.stringify(waitingIds)
        || recomputed.canMix !== Boolean(row.can_mix)
        || recomputed.blockedReason !== row.blocked_reason) {
        throw conflict('The board changed. Review the rotation again.');
      }

      const assignedIds = assignments.flatMap((assignment) => assignment.playerIds);
      if (assignedIds.length !== new Set(assignedIds).size) {
        throw conflict('The stored rotation overlaps players and cannot be applied.');
      }
      for (const assignment of assignments) {
        const court = this.requireCourt(assignment.courtId);
        if (court.status !== 'available' || this.playerRowsForCourt(assignment.courtId).length > 0) {
          throw conflict('A planned court is no longer empty and available.');
        }
      }
      const players = this.playerRowsByIds(assignedIds);
      if (players.length !== assignedIds.length || players.some((player) =>
        player.attendance !== 'ready' || player.location_type !== 'holding-pool')) {
        throw conflict('A planned player is no longer waiting and ready.');
      }

      const assigned = new Set(assignedIds);
      const remaining = this.containerIds('holding-pool').filter((id) => !assigned.has(id));
      const moveToCourt = this.db.prepare(`UPDATE players SET location_type = 'court',
        next_lane = NULL, court_id = ?, position = ? WHERE id = ?`);
      for (const assignment of assignments) {
        assignment.playerIds.forEach((playerId, position) => {
          moveToCourt.run(assignment.courtId, position, playerId);
        });
      }
      this.rewritePositions(remaining);
      this.db.prepare(`UPDATE rotation_plans SET status = 'applied', resolved_at = ?
        WHERE id = ? AND status = 'pending'`).run(at, row.id);
      this.resolveAllProposals();
      this.syncSessionPlayers();
      this.syncWaitingIntervals();
      this.bumpRotationRevision();
      this.audit('rotation_plan.applied', 'rotation_plan', row.id, {
        sessionId: row.session_id,
        reviewedRevision: row.revision,
        approveMixed,
        reason: 'operator-approved-review',
        assignments: assignments.map((assignment) => ({
          courtId: assignment.courtId,
          playerIds: assignment.playerIds,
          mixed: assignment.mixed,
        })),
      });
      return this.mapRotationPlan(this.requireRotationPlan(row.id));
    }).immediate();
  }

  persistProposal(draft: ProposalDraft): MatchProposal {
    return this.db.transaction(() => {
      this.assertSessionOpen();
      const size = this.groupSize();
      const context = this.getMatchContext(draft.mixed === true);
      if ((draft.contextRevision !== undefined && draft.contextRevision !== context.revision)
        || Boolean(draft.mixed) !== context.mixed) {
        throw conflict('The session changed while teams were prepared. Review the next group again.');
      }
      const uniqueIds = new Set(draft.playerIds);
      if (draft.playerIds.length !== size || uniqueIds.size !== size) {
        throw badRequest(`A proposal must contain exactly ${size} unique players.`);
      }
      const players = this.playerRowsByIds(draft.playerIds);
      if (players.length !== size || !this.matchesSelectedGroup(draft.playerIds, context.candidates.map((player) => player.id)) || players.some(
        (player) => player.location_type !== 'holding-pool' || player.attendance !== 'ready',
      )) {
        throw conflict('The holding roster changed while the proposal was prepared. Try again.');
      }
      const selectedById = new Map(players.map((player) => [player.id, player]));
      const ordered = draft.playerIds.map((id) => selectedById.get(id));
      if (ordered.some((player) => player === undefined)) {
        throw conflict('The holding roster changed while the proposal was prepared. Try again.');
      }
      const bands = new Set(players.map((player) => player.skill_level));
      const targetLane: QueueLane = bands.size === 1 && players[0]!.skill_level !== 'unrated'
        ? parseQueueLane(players[0]!.skill_level) : 'mixed';
      const createdAt = nowMs();
      const proposal: MatchProposal = {
        id: randomUUID(),
        source: draft.source,
        status: 'pending',
        playerIds: [...draft.playerIds],
        players: ordered.map((player) => this.mapPlayer(player!)),
        targetLane,
        mixed: context.mixed,
        summary: 'Next in queue.',
        notice: draft.notice,
        createdAt,
        expiresAt: createdAt + PROPOSAL_TTL_MS,
      };
      this.db.prepare(
        `INSERT INTO match_proposals (
          id, source, status, player_ids_json, target_lane,
          notice, created_at, expires_at, resolved_at, mixed, context_revision
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        proposal.id,
        proposal.source,
        JSON.stringify(proposal.playerIds),
        proposal.targetLane,
        proposal.notice,
        proposal.createdAt,
        proposal.expiresAt,
        context.mixed ? 1 : 0,
        context.revision,
      );
      this.audit('match_proposal.created', 'match_proposal', proposal.id, {
        source: proposal.source,
        targetLane,
        playerCount: size,
      });
      return proposal;
    }).immediate();
  }

  applyProposal(proposalId: string, courtId?: number, approveMixed = false): AppSnapshot {
    this.expireProposalsCommitted();
    return this.mutate(() => {
      const proposal = this.requireProposal(proposalId);
      if (proposal.status !== 'pending') {
        throw conflict(`This proposal is already ${proposal.status}.`);
      }
      const size = this.groupSize();
      if (proposal.mixed === 1 && !approveMixed) throw conflict('Approve mixed levels before assigning this group.');
      const context = this.getMatchContext(proposal.mixed === 1);
      if (proposal.context_revision !== context.revision || Boolean(proposal.mixed) !== context.mixed) {
        throw conflict('The session changed. Review the next group again.');
      }
      const playerIds = parseJsonStringArray(proposal.player_ids_json, 'proposal');
      if (playerIds.length !== size || new Set(playerIds).size !== size) {
        throw conflict('The stored proposal is invalid and cannot be applied.');
      }
      const players = this.playerRowsByIds(playerIds);
      if (players.length !== size || !this.matchesSelectedGroup(playerIds, context.candidates.map((player) => player.id)) || players.some(
        (player) => player.location_type !== 'holding-pool' || player.attendance !== 'ready',
      )) {
        throw conflict('This proposal is stale because one or more players are no longer available.');
      }

      const selected = new Set(playerIds);
      if (courtId !== undefined) {
        const court = this.requireCourt(courtId);
        if (court.status !== 'available' || this.playerRowsForCourt(courtId).length > 0) {
          throw conflict('Choose an empty, available court.');
        }
      }
      const holdingIds = this.containerIds('holding-pool').filter((id) => !selected.has(id));
      this.rewritePositions(holdingIds);
      const nextIds = courtId === undefined ? this.containerIds('next-game-pool', proposal.target_lane) : [];
      const moveToNext = this.db.prepare(
        `UPDATE players
         SET location_type = 'next-game-pool', next_lane = ?, court_id = NULL
         WHERE id = ?`,
      );
      const moveToCourt = this.db.prepare(`UPDATE players SET location_type = 'court',
        next_lane = NULL, court_id = ?, position = ? WHERE id = ?`);
      for (const playerId of playerIds) {
        if (courtId === undefined) moveToNext.run(proposal.target_lane, playerId);
        else moveToCourt.run(courtId, nextIds.length, playerId);
        nextIds.push(playerId);
      }
      this.rewritePositions(nextIds);
      this.db.prepare(
        `UPDATE match_proposals
         SET status = 'applied', resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(nowMs(), proposalId);
      this.audit('match_proposal.applied', 'match_proposal', proposalId, {
        targetLane: proposal.target_lane,
        playerCount: size,
        courtId: courtId ?? 0,
      });
    });
  }

  rejectProposal(proposalId: string): MatchProposal {
    this.expireProposalsCommitted();
    return this.db.transaction(() => {
      const proposal = this.requireProposal(proposalId);
      if (proposal.status === 'rejected' || proposal.status === 'expired') {
        return this.mapProposal(proposal);
      }
      if (proposal.status !== 'pending') {
        throw conflict(`This proposal is already ${proposal.status}.`);
      }
      this.db.prepare(
        `UPDATE match_proposals
         SET status = 'rejected', resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(nowMs(), proposalId);
      this.audit('match_proposal.rejected', 'match_proposal', proposalId, {});
      return this.mapProposal(this.requireProposal(proposalId));
    }).immediate();
  }

  getAuditEntriesForTests(): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT action, entity_type, entity_id, metadata_json, created_at
       FROM audit_log ORDER BY created_at, id`,
    ).all() as Array<Record<string, unknown>>;
  }

  private mutate(operation: () => void, allowClosed = false): AppSnapshot {
    return this.db.transaction(() => {
      if (!allowClosed) this.assertSessionOpen();
      const changesBefore = this.db.prepare('SELECT total_changes()').pluck().get() as number;
      operation();
      const changed = (this.db.prepare('SELECT total_changes()').pluck().get() as number) > changesBefore;
      if (changed) {
        if (this.currentSession().endedAt === null) this.syncSessionPlayers();
        this.syncWaitingIntervals();
        this.bumpRotationRevision();
        this.expirePendingRotationPlans(nowMs());
      }
      this.expirePendingProposals(nowMs());
      return this.readSnapshot(nowMs());
    }).immediate();
  }

  private readSnapshot(at: number): AppSnapshot {
    const settings = this.getSettings();
    const session = this.currentSession();
    const playerRows = this.db.prepare(
      `SELECT id, name, skill_level, skill_rating, play_style,
              attendance, source, external_id,
              location_type, next_lane, position, court_id, created_at, waiting_since
       FROM players WHERE EXISTS (
         SELECT 1 FROM session_players sp WHERE sp.session_id = ? AND sp.player_id = players.id
       )
       ORDER BY location_type, next_lane, court_id, position, created_at, id`,
    ).all(session.id) as PlayerRow[];
    const roster = playerRows.map((row) => this.mapPlayer(row));
    const players = roster.filter((player) => player.attendance === 'ready');

    const holdingPool = players.filter((player) => player.location.type === 'holding-pool');
    const nextGamePool = {
      beginner: players.filter(
        (player) => player.location.type === 'next-game-pool' && player.location.lane === 'beginner',
      ),
      intermediate: players.filter(
        (player) => player.location.type === 'next-game-pool' && player.location.lane === 'intermediate',
      ),
      advanced: players.filter(
        (player) => player.location.type === 'next-game-pool' && player.location.lane === 'advanced',
      ),
      mixed: players.filter(
        (player) => player.location.type === 'next-game-pool' && player.location.lane === 'mixed',
      ),
    };

    const courtRows = this.db.prepare(
      'SELECT id, status, game_started_at FROM courts ORDER BY id',
    ).all() as CourtRow[];
    const courts: Court[] = courtRows.filter((row) => row.id <= settings.courtCount).map((row) => ({
      id: row.id,
      name: settings.courtNames[row.id - 1]!,
      status: row.status,
      players: players.filter(
        (player) => player.location.type === 'court' && player.location.courtId === row.id,
      ),
      gameStartedAt: row.game_started_at,
      timeElapsed: row.game_started_at === null
        ? 0
        : Math.max(0, Math.floor((at - row.game_started_at) / 1000)),
    }));

    const gameHistory = (this.db.prepare(
      `SELECT *
       FROM game_history WHERE session_id = ? ORDER BY ended_at DESC, rowid DESC`,
    ).all(session.id) as HistoryRow[]).map<GameHistory>((row) => ({
      id: row.id,
      sessionId: row.session_id,
      courtId: row.court_id,
      courtName: row.court_name ?? `Court ${row.court_id}`,
      players: parseJsonStringArray(row.player_names_json, 'history'),
      playerIds: parseJsonStringArray(row.player_ids_json, 'history identity'),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      duration: row.duration,
      status: row.status,
      reason: row.reason,
      correctedAt: row.corrected_at,
    }));

    const matchProposals = (this.db.prepare(
      `SELECT id, source, status, player_ids_json, target_lane, mixed, context_revision,
              notice, created_at, expires_at
       FROM match_proposals
       WHERE status = 'pending'
       ORDER BY created_at DESC, id DESC`,
    ).all() as ProposalRow[]).map((row) => this.mapProposal(row));

    const sessions = this.db.prepare(`SELECT id, name, started_at AS startedAt, ended_at AS endedAt
      FROM sessions ORDER BY started_at DESC, rowid DESC`).all() as Session[];
    return { settings, session, sessions, roster, courts, holdingPool, nextGamePool, gameHistory,
      matchProposals, rotation: this.rotationSelection() };
  }

  private mapPlayer(row: PlayerRow): Player {
    const stats = this.db.prepare(`SELECT games_played, played_seconds FROM session_players
      WHERE session_id = ? AND player_id = ?`).get(this.currentSession().id, row.id) as
      { games_played: number; played_seconds: number } | undefined;
    const skillLevel = parseSkillLevel(row.skill_level);
    let location: PlayerLocation;
    if (row.location_type === 'holding-pool') {
      location = { type: 'holding-pool', index: row.position };
    } else if (row.location_type === 'next-game-pool') {
      if (row.next_lane === null) throw new Error('Stored next-game lane is missing.');
      location = {
        type: 'next-game-pool',
        lane: parseQueueLane(row.next_lane),
        index: row.position,
      };
    } else {
      if (row.court_id === null) throw new Error('Stored court assignment is missing.');
      location = { type: 'court', courtId: row.court_id };
    }
    return {
      id: row.id,
      name: row.name,
      skillLevel,
      skillRating: row.skill_rating,
      playStyle: parsePlayStyle(row.play_style),
      attendance: row.attendance,
      source: row.source,
      externalId: row.external_id,
      location,
      createdAt: row.created_at,
      gamesPlayed: stats?.games_played ?? 0,
      playedSeconds: stats?.played_seconds ?? 0,
      waitingSince: row.waiting_since,
    };
  }

  private mapProposal(row: ProposalRow): MatchProposal {
    const playerIds = parseJsonStringArray(row.player_ids_json, 'proposal');
    const playersById = new Map(
      this.playerRowsByIds(playerIds).map((player) => [player.id, player]),
    );
    const players = playerIds
      .map((playerId) => playersById.get(playerId))
      .filter((player): player is PlayerRow => player !== undefined)
      .map((player) => this.mapPlayer(player));

    return {
      id: row.id,
      source: row.source,
      status: row.status,
      playerIds,
      players,
      targetLane: row.target_lane,
      mixed: row.mixed === 1,
      summary: 'Next in queue.',
      notice: row.notice,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  private storeRotationAssignments(
    assignments: RotationPlan['assignments'],
  ): StoredRotationAssignment[] {
    return assignments.map((assignment) => ({
      courtId: assignment.courtId,
      courtName: assignment.courtName,
      playerIds: assignment.players.map((player) => player.id),
      mixed: assignment.mixed,
      metrics: { ...assignment.metrics },
    }));
  }

  private parseStoredRotationAssignments(value: string): StoredRotationAssignment[] {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('Stored rotation assignments are invalid.');
    return parsed.map((entry) => {
      if (!entry || typeof entry !== 'object') throw new Error('Stored rotation assignment is invalid.');
      const item = entry as Record<string, unknown>;
      const metrics = item.metrics as Record<string, unknown> | undefined;
      if (!Number.isInteger(item.courtId) || typeof item.courtName !== 'string'
        || !Array.isArray(item.playerIds)
        || !item.playerIds.every((id) => typeof id === 'string')
        || new Set(item.playerIds).size !== item.playerIds.length
        || typeof item.mixed !== 'boolean' || !metrics
        || (metrics.ratingDifference !== null && typeof metrics.ratingDifference !== 'number')
        || !Number.isInteger(metrics.repeatPartners) || !Number.isInteger(metrics.repeatOpponents)) {
        throw new Error('Stored rotation assignment is invalid.');
      }
      return {
        courtId: item.courtId as number,
        courtName: item.courtName,
        playerIds: item.playerIds as string[],
        mixed: item.mixed,
        metrics: {
          ratingDifference: metrics.ratingDifference as number | null,
          repeatPartners: metrics.repeatPartners as number,
          repeatOpponents: metrics.repeatOpponents as number,
        },
      };
    });
  }

  private mapRotationPlan(row: RotationPlanRow): RotationPlan {
    const storedAssignments = this.parseStoredRotationAssignments(row.assignments_json);
    const waitingIds = parseJsonStringArray(row.waiting_player_ids_json, 'rotation waiting');
    const allIds = [...storedAssignments.flatMap((assignment) => assignment.playerIds), ...waitingIds];
    const playersById = new Map(this.playerRowsByIds([...new Set(allIds)])
      .map((player) => [player.id, this.mapPlayer(player)]));
    const requireMapped = (id: string): Player => {
      const player = playersById.get(id);
      if (!player) throw new Error('A stored rotation player is no longer available.');
      return player;
    };
    return {
      id: row.id,
      sessionId: row.session_id,
      revision: row.revision,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status,
      allowMixed: row.allow_mixed === 1,
      canMix: row.can_mix === 1,
      policy: {
        rotationMode: row.rotation_mode,
        avoidRepeatPartners: row.avoid_repeat_partners === 1,
      },
      assignments: storedAssignments.map((assignment) => ({
        courtId: assignment.courtId,
        courtName: assignment.courtName,
        players: assignment.playerIds.map(requireMapped),
        mixed: assignment.mixed,
        metrics: { ...assignment.metrics },
      })),
      waiting: waitingIds.map(requireMapped),
      blockedReason: row.blocked_reason,
    };
  }

  private requireRotationPlan(planId: string): RotationPlanRow {
    const plan = this.db.prepare('SELECT * FROM rotation_plans WHERE id = ?')
      .get(planId) as RotationPlanRow | undefined;
    if (!plan) throw notFound('Rotation plan not found.');
    return plan;
  }

  private rotationAssignmentsRemainIntact(assignments: StoredRotationAssignment[]): boolean {
    return assignments.every((assignment) => {
      const current = this.playerRowsForCourt(assignment.courtId).map((player) => player.id);
      return current.length === assignment.playerIds.length
        && current.every((id, index) => id === assignment.playerIds[index]);
    });
  }

  private requirePlayerRow(playerId: string): PlayerRow {
    const player = this.db.prepare(
      `SELECT id, name, skill_level, skill_rating, play_style,
              attendance, source, external_id,
              location_type, next_lane, position, court_id, created_at, waiting_since
       FROM players WHERE id = ? AND EXISTS (
         SELECT 1 FROM session_players sp WHERE sp.session_id = ? AND sp.player_id = players.id
       )`,
    ).get(playerId, this.currentSession().id) as PlayerRow | undefined;
    if (!player) throw notFound('Player not found.');
    return player;
  }

  private requireCourt(courtId: number): CourtRow {
    if (!Number.isInteger(courtId) || courtId < 1 || courtId > this.getSettings().courtCount) {
      throw notFound('Court not found.');
    }
    const court = this.db.prepare(
      'SELECT id, status, game_started_at FROM courts WHERE id = ?',
    ).get(courtId) as CourtRow | undefined;
    if (!court) throw notFound('Court not found.');
    return court;
  }

  private requireProposal(proposalId: string): ProposalRow {
    const proposal = this.db.prepare(
      `SELECT id, source, status, player_ids_json, target_lane, mixed, context_revision,
              notice, created_at, expires_at
       FROM match_proposals WHERE id = ?`,
    ).get(proposalId) as ProposalRow | undefined;
    if (!proposal) throw notFound('Match proposal not found.');
    return proposal;
  }

  private playerRowsForCourt(courtId: number): PlayerRow[] {
    return this.db.prepare(
      `SELECT id, name, skill_level, skill_rating, play_style,
              attendance, source, external_id,
              location_type, next_lane, position, court_id, created_at, waiting_since
       FROM players
       WHERE location_type = 'court' AND court_id = ? AND EXISTS (
         SELECT 1 FROM session_players sp WHERE sp.session_id = ? AND sp.player_id = players.id
       )
       ORDER BY position, created_at, id`,
    ).all(courtId, this.currentSession().id) as PlayerRow[];
  }

  private playerRowsByIds(playerIds: string[]): PlayerRow[] {
    if (playerIds.length === 0) return [];
    const placeholders = playerIds.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT id, name, skill_level, skill_rating, play_style,
              attendance, source, external_id,
              location_type, next_lane, position, court_id, created_at, waiting_since
       FROM players WHERE id IN (${placeholders}) AND EXISTS (
         SELECT 1 FROM session_players sp WHERE sp.session_id = ? AND sp.player_id = players.id
       )`,
    ).all(...playerIds, this.currentSession().id) as PlayerRow[];
  }

  private assertPlayerRosterUnlocked(player: PlayerRow): void {
    if (player.location_type !== 'court' || player.court_id === null) return;
    const court = this.requireCourt(player.court_id);
    if (court.status === 'in-play') {
      throw conflict('Players cannot be moved, removed, or change attendance while their game is in progress.');
    }
  }

  private assertPlayerReady(player: PlayerRow): void {
    if (player.attendance !== 'ready') {
      throw conflict('Only checked-in, ready players can enter queues or courts.');
    }
  }

  private normalizeRosterImport(source: string, rows: RosterImportRow[]): {
    source: string;
    rows: RosterImportRow[];
  } {
    if (typeof source !== 'string') throw badRequest('A roster source is required.');
    const normalizedSource = source.trim().toLowerCase();
    if (normalizedSource.length < 1 || normalizedSource.length > 80) {
      throw badRequest('Roster source must contain between 1 and 80 characters.');
    }
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) {
      throw badRequest('A roster import must contain between 1 and 200 rows.');
    }
    const identities = new Set<string>();
    const normalizedRows = rows.map((row, index) => {
      if (!row || typeof row !== 'object') throw badRequest(`Roster row ${index + 1} is invalid.`);
      const externalId = typeof row.externalId === 'string' ? row.externalId.trim() : '';
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (externalId.length < 1 || externalId.length > 100) {
        throw badRequest(`Roster row ${index + 1} requires an external ID of 1 to 100 characters.`);
      }
      if (identities.has(externalId)) {
        throw badRequest(`Roster row ${index + 1} repeats an external ID in this import.`);
      }
      identities.add(externalId);
      if (name.length < 1 || name.length > 80 || !isSkillLevel(row.skillLevel)
        || (row.skillRating !== null && (!Number.isFinite(row.skillRating) || row.skillRating < 1 || row.skillRating > 6))
        || !isPlayStyle(row.playStyle)) {
        throw badRequest(`Roster row ${index + 1} has invalid player details.`);
      }
      return { externalId, name, skillLevel: row.skillLevel,
        skillRating: row.skillRating, playStyle: row.playStyle };
    });
    return { source: normalizedSource, rows: normalizedRows };
  }

  private readRosterImportPreview(input: {
    source: string;
    rows: RosterImportRow[];
  }): RosterImportPreview {
    let enrollCount = 0;
    const rows: RosterImportPreview['rows'] = input.rows.map((row) => {
      const identities = this.rosterIdentityRows(input.source, row.externalId);
      if (identities.length > 1) return { ...row, status: 'conflict', canUpdate: false,
        message: 'Multiple stored profiles use this source and external ID. Resolve the identity ambiguity before importing.' };
      const [existing] = identities;
      if (!existing) return { ...row, status: 'new', message: null };
      const current = { name: existing.name, skillLevel: parseSkillLevel(existing.skill_level),
        skillRating: existing.skill_rating, playStyle: parsePlayStyle(existing.play_style) };
      const matches = existing.name === row.name && existing.skill_level === row.skillLevel
        && existing.skill_rating === row.skillRating && existing.play_style === row.playStyle;
      const active = existing.location_type === 'court' && existing.court_id !== null
        && this.requireCourt(existing.court_id).status === 'in-play';
      if (!this.isCurrentSessionMember(existing.id) && (matches || !active)) enrollCount += 1;
      return matches
        ? { ...row, status: 'existing', message: null }
        : { ...row, status: 'conflict', current, canUpdate: !active,
          message: active ? 'This player has a game in progress. End the game before correcting their profile.'
            : 'This source and external ID already have different player details. Review the profile correction.' };
    });
    return {
      source: input.source,
      revision: this.rotationRevision(),
      rows,
      newCount: rows.filter((row) => row.status === 'new').length,
      existingCount: rows.filter((row) => row.status === 'existing').length,
      conflictCount: rows.filter((row) => row.status === 'conflict').length,
      enrollCount,
    };
  }

  private rosterIdentityRows(source: string, externalId: string): PlayerRow[] {
    // Older public fixtures stored title case sources. Never select one identity
    // arbitrarily if an old import has already created a case-colliding duplicate.
    const candidates = this.db.prepare('SELECT * FROM players WHERE external_id = ?').all(externalId) as PlayerRow[];
    return candidates.filter((player) => player.source?.trim().toLowerCase() === source);
  }

  private isCurrentSessionMember(playerId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM session_players WHERE session_id = ? AND player_id = ?')
      .get(this.currentSession().id, playerId));
  }

  private detachPlayer(player: PlayerRow): void {
    let ids: string[];
    if (player.location_type === 'holding-pool') {
      ids = this.containerIds('holding-pool');
    } else if (player.location_type === 'next-game-pool') {
      if (player.next_lane === null) throw new Error('Stored next-game lane is missing.');
      ids = this.containerIds('next-game-pool', parseQueueLane(player.next_lane));
    } else {
      if (player.court_id === null) throw new Error('Stored court assignment is missing.');
      ids = this.containerIds('court', undefined, player.court_id);
    }
    this.rewritePositions(ids.filter((id) => id !== player.id));
  }

  private containerIds(
    locationType: 'holding-pool' | 'next-game-pool' | 'court',
    lane?: QueueLane,
    courtId?: number,
  ): string[] {
    if (locationType === 'holding-pool') {
      return this.db.prepare(
        `SELECT id FROM players
         WHERE location_type = 'holding-pool' AND attendance = 'ready'
           AND EXISTS (SELECT 1 FROM session_players sp
             WHERE sp.session_id = ? AND sp.player_id = players.id)
         ORDER BY position, created_at, id`,
      ).pluck().all(this.currentSession().id) as string[];
    }
    if (locationType === 'next-game-pool') {
      if (!lane) throw new Error('A next-game lane is required.');
      return this.db.prepare(
        `SELECT id FROM players
         WHERE location_type = 'next-game-pool' AND next_lane = ? AND attendance = 'ready'
           AND EXISTS (SELECT 1 FROM session_players sp
             WHERE sp.session_id = ? AND sp.player_id = players.id)
         ORDER BY position, created_at, id`,
      ).pluck().all(lane, this.currentSession().id) as string[];
    }
    if (courtId === undefined) throw new Error('A court ID is required.');
    return this.db.prepare(
      `SELECT id FROM players
       WHERE location_type = 'court' AND court_id = ? AND attendance = 'ready'
         AND EXISTS (SELECT 1 FROM session_players sp
           WHERE sp.session_id = ? AND sp.player_id = players.id)
       ORDER BY position, created_at, id`,
    ).pluck().all(courtId, this.currentSession().id) as string[];
  }

  private rewritePositions(playerIds: string[]): void {
    const updatePosition = this.db.prepare('UPDATE players SET position = ? WHERE id = ?');
    playerIds.forEach((playerId, position) => updatePosition.run(position, playerId));
  }

  private currentSession(): Session {
    return this.db.prepare(`SELECT s.id, s.name, s.started_at AS startedAt, s.ended_at AS endedAt
      FROM sessions s JOIN club_settings c ON c.current_session_id = s.id WHERE c.id = 1`)
      .get() as Session;
  }

  private groupSize(): 2 | 4 {
    return this.getSettings().gameMode === 'singles' ? 2 : 4;
  }

  private matchesSelectedGroup(playerIds: string[], head: string[]): boolean {
    const selected = new Set(playerIds);
    return head.length === this.groupSize() && head.every((id) => selected.has(id));
  }

  private rotationRevision(): number {
    return this.db.prepare('SELECT rotation_revision FROM club_settings WHERE id = 1').pluck().get() as number;
  }

  private bumpRotationRevision(): void {
    this.db.prepare('UPDATE club_settings SET rotation_revision = rotation_revision + 1 WHERE id = 1').run();
  }

  private syncWaitingIntervals(): void {
    this.db.prepare(`UPDATE players SET waiting_since = CASE
      WHEN attendance = 'ready' AND location_type != 'court' AND EXISTS (
        SELECT 1 FROM session_players sp WHERE sp.session_id = ? AND sp.player_id = players.id
      ) THEN COALESCE(waiting_since, ?) ELSE NULL END`).run(this.currentSession().id, nowMs());
  }

  private assertSessionOpen(): void {
    if (this.currentSession().endedAt !== null) {
      throw conflict('This session is closed. Start a new session before making changes.');
    }
  }

  private assertNoActiveGames(): void {
    if (this.db.prepare("SELECT id FROM courts WHERE status = 'in-play' LIMIT 1").get()) {
      throw conflict('End all active games first.');
    }
  }

  private resolveAllProposals(): void {
    const at = nowMs();
    this.db.prepare(`UPDATE match_proposals SET status = 'expired', resolved_at = ?
      WHERE status = 'pending'`).run(at);
    this.db.prepare(`UPDATE rotation_plans SET status = 'expired', resolved_at = ?
      WHERE status = 'pending'`).run(at);
  }

  private syncSessionPlayers(playerIds?: readonly string[]): void {
    const sessionId = this.currentSession().id;
    // No player foreign key: the attendance ledger must survive roster corrections/removals.
    if (playerIds !== undefined) {
      const enroll = this.db.prepare(`INSERT OR IGNORE INTO session_players
        (session_id, player_id, name, source, external_id, attendance, checked_in_at)
        SELECT ?, id, name, source, external_id, attendance,
          CASE WHEN attendance = 'ready' THEN ? ELSE NULL END FROM players WHERE id = ?`);
      const checkedInAt = nowMs();
      for (const playerId of new Set(playerIds)) enroll.run(sessionId, checkedInAt, playerId);
    }
    this.db.prepare(`INSERT INTO session_players
      (session_id, player_id, name, source, external_id, attendance, checked_in_at)
      SELECT ?, id, name, source, external_id, attendance,
        CASE WHEN attendance = 'ready' THEN ? ELSE NULL END FROM players WHERE EXISTS (
          SELECT 1 FROM session_players sp WHERE sp.session_id = ? AND sp.player_id = players.id
        )
      ON CONFLICT(session_id, player_id) DO UPDATE SET name = excluded.name,
        source = excluded.source, external_id = excluded.external_id,
        attendance = excluded.attendance,
        checked_in_at = COALESCE(session_players.checked_in_at, excluded.checked_in_at)`)
      .run(sessionId, nowMs(), sessionId);
  }

  private expirePendingProposals(at: number): void {
    this.db.prepare(
      `UPDATE match_proposals
       SET status = 'expired', resolved_at = ?
       WHERE status = 'pending' AND expires_at <= ?`,
    ).run(at, at);
  }

  private expirePendingRotationPlans(at: number): void {
    const session = this.currentSession();
    const revision = this.rotationRevision();
    this.db.prepare(`UPDATE rotation_plans SET status = 'expired', resolved_at = ?
      WHERE status = 'pending'
        AND (expires_at <= ? OR session_id != ? OR revision != ?)`)
      .run(at, at, session.id, revision);
  }

  private pruneRotationPlans(): void {
    this.db.prepare(`DELETE FROM rotation_plans WHERE id IN (
      SELECT id FROM rotation_plans WHERE status != 'pending'
      ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )`).run(MAX_STORED_ROTATION_PLANS - 1);
  }

  private expireProposalsCommitted(): void {
    this.db.transaction(() => this.expirePendingProposals(nowMs())).immediate();
  }

  private audit(
    action: string,
    entityType: string,
    entityId: string | null,
    metadata: Record<string, unknown>,
  ): void {
    this.db.prepare(
      `INSERT INTO audit_log (
        id, action, entity_type, entity_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), action, entityType, entityId, JSON.stringify(metadata), nowMs());
  }
}
