export type SkillLevel = 'beginner' | 'intermediate' | 'advanced' | 'unrated';
export type QueueLane = 'beginner' | 'intermediate' | 'advanced' | 'mixed';
export type RosterMapping = Partial<Record<'externalId' | 'name' | 'skillLevel' | 'skillRating' | 'playStyle', string>>;

export type CourtStatus = 'available' | 'in-play' | 'disabled';

export type Attendance = 'expected' | 'ready' | 'resting' | 'departed';

export type PlayerLocation =
  | { type: 'holding-pool'; index: number }
  | { type: 'next-game-pool'; lane: QueueLane; matchGroupId?: string }
  | { type: 'court'; courtId: number };

export interface Player {
  id: string;
  name: string;
  skillLevel: SkillLevel;
  skillRating: number | null;
  playStyle: string;
  attendance: Attendance;
  source: string | null;
  externalId: string | null;
  location: PlayerLocation;
  createdAt: number;
  gamesPlayed?: number;
  playedSeconds?: number;
  waitingSince?: number | null;
}

export interface Court {
  id: number;
  name?: string;
  status: CourtStatus;
  players: Player[];
  gameStartedAt: number | null;
  timeElapsed: number;
}

export interface GameHistory {
  id: string;
  courtId: number;
  players: string[];
  startedAt: number;
  endedAt: number;
  duration: number;
  sessionId?: string;
  playerIds?: string[];
  courtName?: string;
  status?: 'completed' | 'voided';
  reason?: string | null;
  correctedAt?: number | null;
}

export interface ClubSettings {
  venueName: string;
  courtCount: number;
  timezone: string;
  gameMode: 'doubles' | 'singles';
  courtNames?: string[];
  rotationMode?: 'open' | 'skill-banded';
  avoidRepeatPartners?: boolean;
  rosterMapping?: RosterMapping;
}

export interface Session {
  id: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
}

export interface SessionReport {
  generatedAt: number;
  displayTimezone: string;
  session: Session;
  participants: Array<{
    id: string; name: string; source: string | null; externalId: string | null;
    attendance: Attendance; checkedInAt: number | null; gamesPlayed: number; playedSeconds: number;
  }>;
  matches: GameHistory[];
  totals: {
    registeredPlayers: number; checkedInPlayers: number; completedMatches: number;
    voidedMatches: number; correctedMatches: number; completedCourtSeconds: number;
    unattributedCompletedMatches: number;
  };
  activeMatches: number;
}

export interface DailyReport {
  date: string;
  displayTimezone: string;
  generatedAt: number;
  totals: {
    checkedInPlayers: number; completedMatches: number; voidedMatches: number;
    correctedMatches: number; completedCourtSeconds: number;
  };
  courts: Array<{
    courtId: number; courtName: string; completedMatches: number; completedCourtSeconds: number;
    voidedMatches: number; correctedMatches: number;
  }>;
  sessions: Session[];
  matches: GameHistory[];
}

export interface PlayerDisplay {
  settings: ClubSettings;
  session: Session;
  courts: Array<Omit<Court, 'players'> & { players: Array<Pick<Player, 'id' | 'name'>> }>;
  nextGamePool: Partial<Record<QueueLane, Array<Pick<Player, 'id' | 'name'>>>>;
  holdingPool?: Array<Pick<Player, 'id' | 'name'>>;
}

export interface NextGamePool {
  beginner: Player[];
  intermediate: Player[];
  advanced: Player[];
  mixed?: Player[];
}

export interface Rotation {
  requiredPlayers: 2 | 4;
  eligiblePlayerIds: string[];
  needsMixedApproval: boolean;
  waitingBand: SkillLevel | null;
  missingPlayers: number;
}

export interface StagedGroupAssignment {
  sessionId: string;
  lane: QueueLane;
  playerIds: string[];
  approveMixed: boolean;
}

export interface AppSnapshot {
  roster: Player[];
  courts: Court[];
  holdingPool: Player[];
  nextGamePool: NextGamePool;
  gameHistory: GameHistory[];
  matchProposals?: MatchProposal[];
  settings?: ClubSettings;
  session?: Session;
  sessions?: Session[];
  rotation?: Rotation;
}

export type AppState = AppSnapshot;

export interface RosterImportRow {
  externalId: string;
  name: string;
  skillLevel: SkillLevel;
  skillRating: number | null;
  playStyle: string;
}

export interface RosterImportPreview {
  source: string;
  revision?: number;
  enrollCount?: number;
  rows: Array<RosterImportRow & {
    status: 'new' | 'existing' | 'conflict';
    message: string | null;
    current?: Omit<RosterImportRow, 'externalId'>;
    canUpdate?: boolean;
  }>;
  newCount: number;
  existingCount: number;
  conflictCount: number;
}

export interface RosterImportResult {
  snapshot: AppSnapshot;
  added: number;
  skipped: number;
  updated?: number;
  enrolled?: number;
}

export interface RosterImportOptions {
  updateExisting?: boolean;
  revision?: number;
}

export type Destination =
  | { type: 'holding-pool'; index?: number }
  | { type: 'next-game-pool'; lane: QueueLane; matchGroupId?: string }
  | { type: 'court'; courtId: number };

export type ProposalSource = 'ai' | 'rules-fallback';

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'expired';

export interface RotationPlan {
  id: string;
  sessionId: string;
  revision: number;
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
  allowMixed: boolean;
  canMix: boolean;
  policy: { rotationMode: 'open' | 'skill-banded'; avoidRepeatPartners: boolean };
  assignments: Array<{
    courtId: number;
    courtName: string;
    players: Player[];
    mixed: boolean;
    metrics: { ratingDifference: number | null; repeatPartners: number; repeatOpponents: number };
  }>;
  waiting: Player[];
  blockedReason: string | null;
}

export interface MatchProposal {
  id: string;
  source: ProposalSource;
  targetLane: QueueLane;
  mixed?: boolean;
  players: Player[];
  summary: string;
  notice: string;
  expiresAt: number;
  status: ProposalStatus;
}
