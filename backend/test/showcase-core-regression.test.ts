import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import type { HoldingCandidate, SkillLevel } from '../src/models.js';

const repos: Repository[] = [];
const dirs: string[] = [];
const epoch = 1_800_000_000_000;
function repo(file = ':memory:') {
  const value = new Repository(file); repos.push(value); return value;
}
function tempFile() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'pickleball-showcase-core-'));
  dirs.push(directory); return path.join(directory, 'fictional.sqlite');
}
function add(value: Repository, name: string, level: SkillLevel = 'intermediate', rating: number | null = 3.5) {
  return value.createPlayer({ name, skillLevel: level, skillRating: rating, playStyle: 'Balanced' }).holdingPool.at(-1)!.id;
}
function proposal(value: Repository, allowMixed = false) {
  const context = value.getMatchContext(allowMixed);
  return value.persistProposal({ source: 'rules-fallback', playerIds: context.candidates.map((player) => player.id),
    notice: 'Session rotation used.', mixed: context.mixed, contextRevision: context.revision });
}
function complete(value: Repository, ids: string[], duration = 20) {
  ids.forEach((id) => value.movePlayer(id, { type: 'court', courtId: 1 }));
  value.startGame(1); vi.mocked(Date.now).mockReturnValue(Date.now() + duration * 1000);
  return value.endGame(1).gameHistory[0]!;
}
function candidate(rating: number | null, index: number): HoldingCandidate {
  return { id: `p${index}`, skillLevel: rating === null ? 'unrated' : 'intermediate',
    skillRating: rating, playStyle: 'Balanced', createdAt: index };
}
afterEach(() => {
  repos.splice(0).forEach((value) => value.close());
  dirs.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true }));
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe('showcase rotation and nullable ratings', () => {
  it('persists genuine unrated/null imports and mixed staging across reopen without inventing a band', () => {
    const file = tempFile(); const value = repo(file);
    const rows = ['A', 'B', 'C', 'D'].map((name, index) => ({ externalId: `member-${index}`, name,
      skillLevel: 'unrated' as const, skillRating: null, playStyle: 'Balanced' as const }));
    value.importRoster('club', rows);
    value.getSnapshot().roster.forEach((player) => value.setAttendance(player.id, 'ready'));
    const review = proposal(value); expect(review.targetLane).toBe('mixed');
    expect(review.players.every((player) => player.skillRating === null && player.skillLevel === 'unrated')).toBe(true);
    value.applyProposal(review.id); value.close();
    const reopened = repo(file); expect(reopened.getSchemaVersion()).toBe(6);
    expect(reopened.getSnapshot().nextGamePool.mixed).toHaveLength(4);
    expect(reopened.previewRosterImport('club', rows).existingCount).toBe(4);
    const unknownId = reopened.getSnapshot().roster[0]!.id;
    expect(() => reopened.movePlayer(unknownId, { type: 'next-game-pool', lane: 'beginner' })).toThrow('mixed staging');
    expect(() => reopened.createPlayer({ name: 'Bad', skillLevel: 'unrated', skillRating: 0, playStyle: 'Balanced' })).toThrow();
  });

  it('measures the current wait, preserves reorder time and restarts after breaks and completed games', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch); const value = repo();
    const ids = ['A', 'B', 'C', 'D'].map((name) => add(value, name));
    expect(value.getSnapshot().holdingPool[0]!.waitingSince).toBe(epoch);
    vi.mocked(Date.now).mockReturnValue(epoch + 10_000);
    value.reorderHoldingPool(ids[0]!, 1);
    expect(value.getSnapshot().roster.find((player) => player.id === ids[0])!.waitingSince).toBe(epoch);
    value.setAttendance(ids[0]!, 'resting');
    expect(value.getSnapshot().roster.find((player) => player.id === ids[0])!.waitingSince).toBeNull();
    value.setAttendance(ids[0]!, 'ready');
    expect(value.getSnapshot().holdingPool.at(-1)!.waitingSince).toBe(epoch + 10_000);
    const history = complete(value, ids);
    expect(value.getSnapshot().holdingPool.every((player) => player.waitingSince === history.endedAt)).toBe(true);
  });

  it('does not skip an incomplete oldest band or mix without explicit host approval', () => {
    const value = repo(); add(value, 'Oldest', 'beginner', null);
    ['A', 'B', 'C', 'D'].forEach((name) => add(value, name, 'advanced', 4.5));
    value.updateSettings({ ...value.getSettings(), rotationMode: 'skill-banded' });
    expect(value.getSnapshot().rotation).toMatchObject({ waitingBand: 'beginner', missingPlayers: 3,
      needsMixedApproval: true });
    expect(() => value.getMatchContext()).toThrow(expect.objectContaining({ code: 'BAND_INCOMPLETE' }));
    const review = proposal(value, true); expect(review.mixed).toBe(true);
    expect(review.players[0]!.name).toBe('Oldest');
    expect(() => value.applyProposal(review.id, 1)).toThrow('Approve mixed levels');
    expect(value.applyProposal(review.id, 1, true).courts[0]!.players).toHaveLength(4);
  });

  it('uses earliest same-band players and treats unrated as its own explicit band', () => {
    const value = repo(); const oldest = add(value, 'Unrated 1', 'unrated', null);
    add(value, 'Rated 1'); add(value, 'Rated 2');
    const band = ['Unrated 2', 'Unrated 3', 'Unrated 4'].map((name) => add(value, name, 'unrated', null));
    value.updateSettings({ ...value.getSettings(), rotationMode: 'skill-banded' });
    expect(value.getMatchContext().candidates.map((player) => player.id)).toEqual([oldest, ...band]);
    const review = proposal(value); expect(review.mixed).toBe(false); expect(review.targetLane).toBe('mixed');
  });

  it('rejects reviews prepared before same-group queue reorder, settings edits or history correction', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch); const value = repo();
    const ids = ['A', 'B', 'C', 'D'].map((name) => add(value, name));
    const context = value.getMatchContext(); value.reorderHoldingPool(ids[0]!, 1);
    expect(() => value.persistProposal({ source: 'rules-fallback', notice: '',
      playerIds: context.candidates.map((player) => player.id), contextRevision: context.revision })).toThrow('session changed');
    const review = proposal(value); value.reorderHoldingPool(ids[0]!, 0);
    expect(() => value.applyProposal(review.id, 1)).toThrow('session changed');
    const game = complete(value, ids); const pending = proposal(value);
    value.correctRecordedGame(game.id, { playerIds: ids, durationSeconds: 10, reason: 'Clock correction' });
    expect(() => value.applyProposal(pending.id, 1)).toThrow('expired');
  });

  it('keeps a pending review usable across idempotent attendance, movement, reorder and void retries', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch); const value = repo();
    const ids = ['A', 'B', 'C', 'D'].map((name) => add(value, name));
    const game = complete(value, ids); value.voidRecordedGame(game.id, 'Incorrect completion');
    const review = proposal(value); const revision = value.getMatchContext().revision;
    value.setAttendance(ids[0]!, 'ready');
    value.movePlayer(ids[0]!, { type: 'holding-pool', index: 0 });
    value.reorderHoldingPool(ids[0]!, 0);
    value.voidRecordedGame(game.id, 'Incorrect completion');
    expect(value.getMatchContext().revision).toBe(revision);
    expect(value.applyProposal(review.id, 1).courts[0]!.players).toHaveLength(4);
  });

  it('validates court names, preserves recorded names and saves only column metadata while a match is active', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch); const value = repo();
    value.updateSettings({ ...value.getSettings(), courtCount: 2, courtNames: ['North', 'South'] });
    expect(() => value.updateSettings({ ...value.getSettings(), courtNames: ['North', ' north '] })).toThrow('court names');
    expect(() => value.updateRosterMapping({ name: 'Player', externalId: 'Player' })).toThrow('different column');
    const ids = ['A', 'B', 'C', 'D'].map((name) => add(value, name));
    ids.forEach((id) => value.movePlayer(id, { type: 'court', courtId: 1 })); value.startGame(1);
    expect(value.updateRosterMapping({ name: 'Full name', externalId: 'Member number' }).settings.rosterMapping)
      .toEqual({ name: 'Full name', externalId: 'Member number' });
    expect(() => value.updateSettings({ ...value.getSettings(), rotationMode: 'skill-banded' })).toThrow('End all active');
    value.endGame(1); value.updateSettings({ ...value.getSettings(), courtNames: ['East', 'West'] });
    expect(value.getSnapshot().gameHistory[0]!.courtName).toBe('North');
    expect(value.getSnapshot().courts[0]!.name).toBe('East');
  });
});

describe('auditable corrections', () => {
  it('voids an active game without completion counts or moving its roster and rejects duplicate void', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch); const value = repo();
    const ids = ['A', 'B', 'C', 'D'].map((name) => add(value, name));
    ids.forEach((id) => value.movePlayer(id, { type: 'court', courtId: 1 })); value.startGame(1);
    vi.mocked(Date.now).mockReturnValue(epoch + 30_000);
    const result = value.voidActiveGame(1, 'Accidental start');
    expect(result.courts[0]).toMatchObject({ status: 'available', gameStartedAt: null });
    expect(result.courts[0]!.players.map((player) => player.id)).toEqual(ids);
    expect(result.roster.every((player) => player.gamesPlayed === 0 && player.waitingSince === null)).toBe(true);
    expect(result.gameHistory[0]).toMatchObject({ status: 'voided', reason: 'Accidental start', duration: 30 });
    expect(() => value.voidActiveGame(1, 'Retry request')).toThrow('No game');
    expect(value.getSnapshot().gameHistory).toHaveLength(1);
    value.startGame(1); expect(value.endGame(1).roster.every((player) => player.gamesPlayed === 1)).toBe(true);
  });

  it('corrects participant identities/time, including removed players, recalculates ledgers and audits once on retry', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch); const value = repo();
    const ids = ['A', 'B', 'C', 'D', 'E'].map((name) => add(value, name));
    const game = complete(value, ids.slice(0, 4), 60); value.removePlayer(ids[4]!);
    const correctedIds = [ids[0]!, ids[1]!, ids[2]!, ids[4]!];
    const request = { playerIds: correctedIds, durationSeconds: 30, reason: 'Correct host entry' };
    const result = value.correctRecordedGame(game.id, request);
    expect(result.gameHistory[0]).toMatchObject({ playerIds: correctedIds, players: ['A', 'B', 'C', 'E'], duration: 30 });
    expect(result.roster.find((player) => player.id === ids[3])!.gamesPlayed).toBe(0);
    expect(result.roster.find((player) => player.id === ids[0])!.playedSeconds).toBe(30);
    expect(value.exportSession('attendance')).toContain('"E","","","departed"');
    const audits = () => value.getAuditEntriesForTests().filter((entry) => entry.action === 'game.corrected');
    expect(audits()).toHaveLength(1); value.correctRecordedGame(game.id, request); expect(audits()).toHaveLength(1);
    expect(JSON.parse(String(audits()[0]!.metadata_json))).toMatchObject({ reason: 'Correct host entry',
      before: { duration: 60 }, after: { duration: 30, playerIds: correctedIds } });
    expect(() => value.correctRecordedGame(game.id, { ...request, playerIds: [ids[0]!, ids[0]!, ids[2]!, ids[3]!] })).toThrow('original group');
    expect(() => value.correctRecordedGame(game.id, { ...request, playerIds: [ids[0]!, ids[1]!, ids[2]!, 'unknown'] })).toThrow('this session');
    expect(() => value.correctRecordedGame(game.id, { ...request, durationSeconds: 70 })).toThrow('future');
  });

  it('voids completed history idempotently without disturbing active games and keeps archives read-only', () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch); const value = repo();
    const ids = ['A', 'B', 'C', 'D'].map((name) => add(value, name));
    const game = complete(value, ids, 60);
    ids.forEach((id) => value.movePlayer(id, { type: 'court', courtId: 1 })); value.startGame(1);
    const corrected = value.voidRecordedGame(game.id, 'Duplicate match entry');
    expect(corrected.courts[0]!.status).toBe('in-play');
    expect(corrected.roster.every((player) => player.gamesPlayed === 0 && player.playedSeconds === 0)).toBe(true);
    value.voidRecordedGame(game.id, 'Duplicate match entry');
    expect(value.getAuditEntriesForTests().filter((entry) => entry.action === 'game.voided.recorded')).toHaveLength(1);
    expect(() => value.correctRecordedGame(game.id, { playerIds: ids, durationSeconds: 10, reason: 'Change it' })).toThrow('voided');
    expect(value.exportSession('matches')).toContain('"voided","Duplicate match entry"');
    value.voidActiveGame(1, 'Session abandoned'); value.closeSession();
    expect(() => value.voidRecordedGame(game.id, 'Late edit')).toThrow('session is closed');
    value.startSession('Next date');
    expect(() => value.voidRecordedGame(game.id, 'Late edit')).toThrow('read-only');
    expect(() => value.voidActiveGame(1, 'x')).toThrow('3 to 160');
  });
});

describe('repeat-aware deterministic teams', () => {
  it('avoids previous partners within one rating-sum point, and can disable that policy', async () => {
    const matcher = new Matchmaker();
    const players = [3, 3, 3.5, 3.5].map(candidate);
    const previousTeams = [['p0', 'p2'], ['p1', 'p3']];
    const varied = await matcher.propose(players, 4, previousTeams, true);
    expect(varied.playerIds).toEqual(['p0', 'p3', 'p1', 'p2']);
    expect((await matcher.propose(players, 4, previousTeams, false)).playerIds)
      .toEqual(['p0', 'p2', 'p1', 'p3']);
  });

  it('never imputes unknown ratings and uses actual recorded nonvoided teammate identities only', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch); const value = repo();
    const ids = ['A', 'B', 'C', 'D'].map((name) => add(value, name, 'unrated', null));
    const game = complete(value, ids); const context = value.getMatchContext();
    expect(context.previousTeams).toEqual([ids.slice(0, 2), ids.slice(2)]);
    const draft = await new Matchmaker().propose(context.candidates, 4, context.previousTeams);
    expect(draft.playerIds).toEqual([ids[0], ids[2], ids[1], ids[3]]);
    expect(draft.notice).toContain('without numeric balance');
    value.voidRecordedGame(game.id, 'Incorrect completion'); expect(value.getMatchContext().previousTeams).toEqual([]);
  });
});

describe('genuine constrained v3 migration', () => {
  it('preserves active courts, identities, archived names/counts, indices and foreign keys through table rebuilds', () => {
    const file = tempFile(); const legacy = new Database(file); const started = epoch - 60_000;
    legacy.exec(`
      CREATE TABLE courts (id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 6),status TEXT NOT NULL,
        game_started_at INTEGER);
      INSERT INTO courts VALUES(1,'in-play',${started});
      CREATE TABLE players(id TEXT PRIMARY KEY,name TEXT NOT NULL,skill_level TEXT NOT NULL
        CHECK(skill_level IN('beginner','intermediate','advanced')),skill_rating REAL NOT NULL CHECK(skill_rating BETWEEN 1 AND 6),
        play_style TEXT NOT NULL,location_type TEXT NOT NULL,next_lane TEXT CHECK(next_lane IN('beginner','intermediate','advanced')),
        position INTEGER NOT NULL,court_id INTEGER REFERENCES courts(id),created_at INTEGER NOT NULL,
        attendance TEXT NOT NULL DEFAULT 'ready',source TEXT,external_id TEXT);
      CREATE INDEX idx_players_location ON players(location_type,next_lane,court_id,position);
      CREATE UNIQUE INDEX idx_players_import_identity ON players(source,external_id);
      INSERT INTO players VALUES('a','Alex','intermediate',3.5,'Balanced','court',NULL,0,1,${started},'ready','club','a');
      INSERT INTO players VALUES('b','Casey','intermediate',3.5,'Balanced','court',NULL,1,1,${started},'ready','club','b');
      CREATE TABLE sessions(id TEXT PRIMARY KEY,name TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER);
      INSERT INTO sessions VALUES('session','Legacy session',${started - 10_000},NULL);
      CREATE UNIQUE INDEX idx_one_open_session ON sessions((1)) WHERE ended_at IS NULL;
      CREATE TABLE club_settings(id INTEGER PRIMARY KEY,venue_name TEXT NOT NULL,court_count INTEGER NOT NULL,
        timezone TEXT NOT NULL,game_mode TEXT NOT NULL,current_session_id TEXT NOT NULL REFERENCES sessions(id));
      INSERT INTO club_settings VALUES(1,'Coastal',2,'Australia/Perth','singles','session');
      CREATE TABLE session_players(session_id TEXT REFERENCES sessions(id),player_id TEXT,name TEXT,source TEXT,external_id TEXT,
        attendance TEXT,checked_in_at INTEGER,games_played INTEGER DEFAULT 0,played_seconds INTEGER DEFAULT 0,PRIMARY KEY(session_id,player_id));
      INSERT INTO session_players VALUES('session','a','Alex','club','a','ready',${started},1,5);
      INSERT INTO session_players VALUES('session','b','Casey','club','b','ready',${started},1,5);
      CREATE TABLE game_history(id TEXT PRIMARY KEY,court_id INTEGER REFERENCES courts(id),player_names_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,ended_at INTEGER NOT NULL,duration INTEGER NOT NULL,
        session_id TEXT REFERENCES sessions(id),player_ids_json TEXT NOT NULL DEFAULT '[]');
      INSERT INTO game_history VALUES('identified',1,'["Alex","Casey"]',${started - 10_000},${started - 5_000},5,'session','["a","b"]');
      INSERT INTO game_history VALUES('legacy',1,'["Unknown","Historic"]',${started - 20_000},${started - 15_000},5,'session','[]');
      CREATE INDEX idx_game_history_court_end ON game_history(court_id,ended_at DESC);
      CREATE INDEX idx_game_history_session ON game_history(session_id,ended_at DESC);
      CREATE TABLE match_proposals(id TEXT PRIMARY KEY,source TEXT NOT NULL,status TEXT NOT NULL,player_ids_json TEXT NOT NULL,
        target_lane TEXT NOT NULL CHECK(target_lane IN('beginner','intermediate','advanced')),
        notice TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,resolved_at INTEGER);
      INSERT INTO match_proposals VALUES('old','rules-fallback','pending','["a","b"]','intermediate','',${started},${epoch + 60_000},NULL);
      CREATE INDEX idx_match_proposals_status_expiry ON match_proposals(status,expires_at);
      CREATE TABLE audit_log(id TEXT PRIMARY KEY,action TEXT,entity_type TEXT,entity_id TEXT,metadata_json TEXT,created_at INTEGER);
      CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
      PRAGMA user_version=3;
    `); legacy.close();
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const migrated = repo(file); const snapshot = migrated.getSnapshot();
    expect(migrated.getSchemaVersion()).toBe(6);
    expect(snapshot.courts[0]).toMatchObject({ status: 'in-play', gameStartedAt: started });
    expect(snapshot.courts[0]!.players.map((player) => player.id)).toEqual(['a', 'b']);
    expect(snapshot.roster.every((player) => player.gamesPlayed === 1 && player.playedSeconds === 5)).toBe(true);
    expect(snapshot.gameHistory.find((game) => game.id === 'legacy')!.playerIds).toEqual([]);
    expect(snapshot.gameHistory.every((game) => game.status === 'completed' && game.courtName === 'Court 1')).toBe(true);
    expect(migrated.rejectProposal('old').status).toBe('expired');
    const completed = migrated.endGame(1); expect(completed.roster.every((player) => player.gamesPlayed === 2)).toBe(true);
    add(migrated, 'Unknown rating', 'unrated', null); migrated.close();
    const inspect = new Database(file); expect(inspect.pragma('foreign_key_check')).toEqual([]);
    const indices = inspect.prepare("SELECT name FROM sqlite_master WHERE type='index'").pluck().all();
    expect(indices).toContain('idx_players_import_identity'); expect(indices).toContain('idx_players_location');
    expect(indices).toContain('idx_match_proposals_status_expiry'); inspect.close();
    expect(repo(file).getSnapshot().roster.find((player) => player.name === 'Unknown rating')!.skillRating).toBeNull();
  });
});
