import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import type { HoldingCandidate } from '../src/models.js';

const repositories: Repository[] = [];
const directories: string[] = [];
function repository(file = ':memory:'): Repository {
  const value = new Repository(file);
  repositories.push(value);
  return value;
}
function add(repo: Repository, name: string, skillRating = 3.5): string {
  const snapshot = repo.createPlayer({ name, skillLevel: 'intermediate', skillRating, playStyle: 'Balanced' });
  return snapshot.holdingPool.at(-1)!.id;
}
function draft(ids: string[]) { return { source: 'rules-fallback' as const, playerIds: ids, notice: 'Queue order used.' }; }
function candidates(ratings: number[]): HoldingCandidate[] {
  return ratings.map((skillRating, index) => ({ id: `player-${index}`, skillLevel: 'intermediate',
    skillRating, playStyle: 'Balanced', createdAt: index }));
}
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('configured club sessions', () => {
  it('runs the same workflow with two and six courts and strictly configured singles/doubles', () => {
    const repo = repository();
    repo.updateSettings({ ...repo.getSettings(), courtCount: 2, courtNames: ['Court 1', 'Court 2'], gameMode: 'singles', timezone: 'Australia/Perth' });
    expect(repo.getSnapshot().courts).toHaveLength(2);
    expect(() => repo.toggleCourtStatus(3)).toThrow('Court not found');
    const ids = [add(repo, 'Jordan'), add(repo, 'Casey'), add(repo, 'Alex')];
    repo.movePlayer(ids[0]!, { type: 'court', courtId: 2 });
    expect(() => repo.startGame(2)).toThrow('exactly 2');
    repo.movePlayer(ids[1]!, { type: 'court', courtId: 2 });
    expect(() => repo.movePlayer(ids[2]!, { type: 'court', courtId: 2 })).toThrow('full');
    repo.startGame(2);
    expect(() => repo.updateSettings({ ...repo.getSettings(), courtCount: 6,
      courtNames: Array.from({ length: 6 }, (_, index) => `Court ${index + 1}`) })).toThrow('End all active');
    repo.endGame(2);
    const expanded = repo.updateSettings({ ...repo.getSettings(), courtCount: 6,
      courtNames: Array.from({ length: 6 }, (_, index) => `Court ${index + 1}`), gameMode: 'doubles' });
    expect(expanded.courts).toHaveLength(6);
    expect(expanded.settings.timezone).toBe('Australia/Perth');
    repo.movePlayer(ids[0]!, { type: 'court', courtId: 6 });
    expect(() => repo.updateSettings({ ...repo.getSettings(), courtCount: 2, courtNames: ['Court 1', 'Court 2'] })).toThrow('Clear courts');
    expect(repo.getSnapshot().courts).toHaveLength(6);
  });

  it('records stable identities, real counts, duration and departed/removed attendance across sessions', () => {
    const repo = repository();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const ids = [add(repo, '=HYPERLINK("bad")'), add(repo, 'Same name'), add(repo, 'Same name'), add(repo, 'Taylor')];
    const firstSession = repo.getSnapshot().session.id;
    ids.forEach((id) => repo.movePlayer(id, { type: 'court', courtId: 1 }));
    repo.startGame(1);
    vi.mocked(Date.now).mockReturnValue(1_800_000_065_000);
    const ended = repo.endGame(1);
    expect(ended.gameHistory[0]).toMatchObject({ sessionId: firstSession, playerIds: ids, duration: 65 });
    expect(ended.roster.every((player) => player.gamesPlayed === 1 && player.playedSeconds === 65)).toBe(true);
    expect(() => repo.endGame(1)).toThrow('No game');
    repo.setAttendance(ids[1]!, 'departed');
    repo.removePlayer(ids[0]!);
    const attendance = repo.exportSession('attendance');
    expect(attendance).toContain(ids[0]);
    expect(attendance).toContain("'=HYPERLINK");
    expect(attendance.match(/"departed"/g)).toHaveLength(2);
    expect(attendance).toContain('"1","65"');
    repo.closeSession();
    const fresh = repo.startSession('Tuesday social', true);
    expect(fresh.roster.map((player) => player.id).sort()).toEqual(ids.slice(1).sort());
    expect(fresh.roster.every((player) => player.attendance === 'expected' && player.gamesPlayed === 0)).toBe(true);
    expect(fresh.gameHistory).toHaveLength(0);
    expect(fresh.sessions).toHaveLength(2);
    expect(repo.exportSession('attendance', firstSession)).toBe(attendance);
    expect(repo.exportSession('matches', firstSession)).toContain(JSON.stringify(ids).replaceAll('"', '""'));
    vi.restoreAllMocks();
  });

  it('closes only after games finish, expires proposals, and blocks all roster/game writes until a new session', () => {
    const repo = repository();
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name) => add(repo, name));
    const proposal = repo.persistProposal(draft(ids.slice(0, 4)));
    repo.applyProposal(proposal.id, 1);
    repo.startGame(1);
    const waitingProposal = repo.persistProposal(draft(ids.slice(4)));
    expect(() => repo.closeSession()).toThrow('End all active');
    expect(() => repo.startSession('Wrong time')).toThrow('Close the current');
    repo.endGame(1);
    const closed = repo.closeSession();
    expect(closed.session.endedAt).not.toBeNull();
    expect(closed.matchProposals).toHaveLength(0);
    expect(repo.rejectProposal(waitingProposal.id).status).toBe('expired');
    expect(() => add(repo, 'No')).toThrow('session is closed');
    expect(() => repo.setAttendance(ids[0]!, 'ready')).toThrow('session is closed');
    expect(() => repo.movePlayer(ids[0]!, { type: 'court', courtId: 1 })).toThrow('session is closed');
    expect(() => repo.toggleCourtStatus(1)).toThrow('session is closed');
    expect(() => repo.getHoldingCandidates()).toThrow('session is closed');
    expect(() => repo.importRoster('csv', [{ externalId: 'new', name: 'No', skillLevel: 'beginner',
      skillRating: 2, playStyle: 'Balanced' }])).toThrow('session is closed');
    expect(repo.closeSession().session).toEqual(closed.session);
    repo.updateSettings({ ...repo.getSettings(), venueName: 'Northern Club' });
    expect(repo.startSession('Next social', true).roster).toHaveLength(8);
  });

  it('preserves FIFO through late arrivals, breaks, duplicate approval, occupied courts and corrections', () => {
    const repo = repository();
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => add(repo, name));
    repo.setAttendance(ids[0]!, 'resting');
    repo.setAttendance(ids[0]!, 'ready');
    expect(repo.getHoldingCandidates().map((player) => player.id)).toEqual(ids.slice(1, 5));
    const proposal = repo.persistProposal(draft(ids.slice(1, 5)));
    repo.reorderHoldingPool(ids[5]!, 0);
    expect(() => repo.applyProposal(proposal.id, 1)).toThrow('changed');
    expect(repo.getSnapshot().courts[0]!.players).toHaveLength(0);
    const head = repo.getHoldingCandidates().map((player) => player.id);
    repo.movePlayer(ids[0]!, { type: 'court', courtId: 1 });
    const current = repo.persistProposal(draft(head));
    expect(() => repo.applyProposal(current.id, 1)).toThrow('empty');
    expect(repo.getSnapshot().holdingPool.slice(0, 4).map((player) => player.id)).toEqual(head);
    repo.movePlayer(ids[0]!, { type: 'holding-pool' });
    expect(() => repo.applyProposal(current.id, 2)).toThrow('changed');
    const fresh = repo.persistProposal(draft(head));
    const applied = repo.applyProposal(fresh.id, 2);
    expect(applied.courts[1]!.players.map((player) => player.id)).toEqual(head);
    expect(applied.courts[1]!.status).toBe('available');
    expect(() => repo.applyProposal(fresh.id, 2)).toThrow('already applied');
    const moveAudit = repo.getAuditEntriesForTests().find((entry) => entry.action === 'player.moved');
    expect(JSON.parse(String(moveAudit?.metadata_json))).toMatchObject({ origin: 'holding-pool',
      destination: 'court', destinationCourtId: 1, destinationIndex: 0 });
  });

  it('persists settings, archives and IDs on reopen without touching unknown databases', () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'pickleball-core-test-'));
    directories.push(directory);
    const file = path.join(directory, 'fictional.sqlite');
    const repo = repository(file);
    const id = add(repo, 'Morgan');
    const sessionId = repo.getSnapshot().session.id;
    repo.updateSettings({ ...repo.getSettings(), courtCount: 2, courtNames: ['Court 1', 'Court 2'], venueName: 'Coastal courts' });
    repo.closeSession();
    repo.close();
    const reopened = repository(file);
    expect(reopened.getSchemaVersion()).toBe(6);
    expect(reopened.getSnapshot()).toMatchObject({ settings: { courtCount: 2, venueName: 'Coastal courts' },
      session: { id: sessionId }, roster: [{ id }] });
    const unknownFile = path.join(directory, 'unknown.sqlite');
    const unknown = new Database(unknownFile);
    unknown.exec('CREATE TABLE unrelated (value TEXT)');
    unknown.close();
    expect(() => new Repository(unknownFile)).toThrow('unrecognized database');
  });

  it('migrates genuine v2 data without fabricating history identities and permits an existing two-player game to finish', () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'pickleball-migration-test-'));
    directories.push(directory);
    const file = path.join(directory, 'legacy.sqlite');
    const repo = repository(file);
    const ids = ['A', 'B'].map((name) => add(repo, name));
    repo.updateSettings({ ...repo.getSettings(), gameMode: 'singles' });
    ids.forEach((id) => repo.movePlayer(id, { type: 'court', courtId: 1 }));
    repo.startGame(1);
    repo.endGame(1);
    ids.forEach((id) => repo.movePlayer(id, { type: 'court', courtId: 1 }));
    repo.startGame(1);
    repo.close();
    const legacy = new Database(file);
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`ALTER TABLE game_history DROP COLUMN status;
      ALTER TABLE game_history DROP COLUMN reason;
      ALTER TABLE game_history DROP COLUMN corrected_at;
      ALTER TABLE game_history DROP COLUMN court_name;
      ALTER TABLE players DROP COLUMN waiting_since;
      DROP INDEX idx_game_history_session;
      ALTER TABLE game_history DROP COLUMN player_ids_json;
      ALTER TABLE game_history DROP COLUMN session_id;
      DROP TABLE rotation_plans;
      DROP TABLE session_players; DROP TABLE club_settings; DROP TABLE sessions;
      PRAGMA user_version = 2;`);
    legacy.close();
    const migrated = repository(file);
    const before = migrated.getSnapshot();
    expect(before.roster.map((player) => player.id).sort()).toEqual(ids.sort());
    expect(before.gameHistory[0]!.playerIds).toEqual([]);
    expect(before.roster.every((player) => player.gamesPlayed === 0)).toBe(true);
    const finished = migrated.endGame(1);
    expect(finished.gameHistory[0]!.playerIds.sort()).toEqual(ids.sort());
    expect(finished.gameHistory).toHaveLength(2);
    expect(finished.roster.every((player) => player.gamesPlayed === 1)).toBe(true);
  });
});

describe('bounded team proposals', () => {
  it('selects FIFO head and balances teams without cherry-picking a later close-rated quartet', async () => {
    const matcher = new Matchmaker();
    const draft = await matcher.propose(candidates([1, 6, 3, 4, 3.1, 3.2, 3.3, 3.4]));
    expect(new Set(draft.playerIds)).toEqual(new Set(['player-0', 'player-1', 'player-2', 'player-3']));
    expect(draft.playerIds).toEqual(['player-0', 'player-1', 'player-2', 'player-3']);
    expect(await matcher.propose(candidates([2, 4, 5]), 2)).toMatchObject({ playerIds: ['player-0', 'player-1'] });
  });
});
