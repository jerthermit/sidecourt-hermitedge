export const skillLevels = ['beginner', 'intermediate', 'advanced', 'unrated'] as const;
export type SkillLevel = (typeof skillLevels)[number];
export const queueLanes = ['beginner', 'intermediate', 'advanced', 'mixed'] as const;
export type QueueLane = (typeof queueLanes)[number];
export type RosterField = 'externalId' | 'name' | 'skillLevel' | 'skillRating' | 'playStyle';
export type RosterColumnMapping = Partial<Record<RosterField, string>>;

export const playStyles = ['Balanced', 'Aggressive', 'Tactical', 'Defensive'] as const;
export type PlayStyle = (typeof playStyles)[number];

export const attendanceStatuses = ['expected', 'ready', 'resting', 'departed'] as const;
export type Attendance = (typeof attendanceStatuses)[number];

export const maxCourtCount = 16;
export type CourtStatus = 'available' | 'in-play' | 'disabled';

export interface ClubSettings {
  venueName: string;
  courtCount: number;
  timezone: string;
  gameMode: 'doubles' | 'singles';
  courtNames: string[];
  rotationMode: 'open' | 'skill-banded';
  avoidRepeatPartners: boolean;
  rosterMapping: RosterColumnMapping;
}

export interface Session {
  id: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
}

export type PlayerLocation =
  | { type: 'holding-pool'; index: number }
  | { type: 'next-game-pool'; lane: QueueLane; index: number }
  | { type: 'court'; courtId: number };

export interface Player {
  id: string;
  name: string;
  skillLevel: SkillLevel;
  skillRating: number | null;
  playStyle: PlayStyle;
  attendance: Attendance;
  source: string | null;
  externalId: string | null;
  location: PlayerLocation;
  createdAt: number;
  gamesPlayed: number;
  playedSeconds: number;
  waitingSince: number | null;
}

export interface Court {
  id: number;
  name: string;
  status: CourtStatus;
  players: Player[];
  gameStartedAt: number | null;
  timeElapsed: number;
}

export interface GameHistory {
  id: string;
  sessionId: string;
  courtId: number;
  courtName: string;
  players: string[];
  playerIds: string[];
  startedAt: number;
  endedAt: number;
  duration: number;
  status: 'completed' | 'voided';
  reason: string | null;
  correctedAt: number | null;
}

export interface SessionReport {
  generatedAt: number;
  /** Current formatting timezone, not the archived session's configuration. */
  displayTimezone: string;
  session: Session;
  participants: Array<{
    id: string;
    name: string;
    source: string | null;
    externalId: string | null;
    attendance: Attendance;
    checkedInAt: number | null;
    gamesPlayed: number;
    playedSeconds: number;
  }>;
  matches: GameHistory[];
  totals: {
    registeredPlayers: number;
    checkedInPlayers: number;
    completedMatches: number;
    voidedMatches: number;
    /** Completed records with a correction; voided records are counted separately. */
    correctedMatches: number;
    completedCourtSeconds: number;
    unattributedCompletedMatches: number;
  };
  activeMatches: number;
}

export interface DailyReport {
  date: string;
  /** Current club timezone, applied to every recorded timestamp in this view. */
  displayTimezone: string;
  generatedAt: number;
  totals: {
    checkedInPlayers: number;
    completedMatches: number;
    voidedMatches: number;
    correctedMatches: number;
    completedCourtSeconds: number;
  };
  /** Recorded court names are retained; renaming a court may produce separate rows. */
  courts: Array<{
    courtId: number;
    courtName: string;
    completedMatches: number;
    completedCourtSeconds: number;
    voidedMatches: number;
    correctedMatches: number;
  }>;
  sessions: Session[];
  /** Entire recorded duration belongs to the match's local start date; not utilization. */
  matches: GameHistory[];
}

export interface NextGamePool {
  beginner: Player[];
  intermediate: Player[];
  advanced: Player[];
  mixed: Player[];
}

export type ProposalSource = 'ai' | 'rules-fallback';
export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'expired';

export interface MatchProposal {
  id: string;
  source: ProposalSource;
  status: ProposalStatus;
  playerIds: string[];
  players: Player[];
  targetLane: QueueLane;
  mixed: boolean;
  summary: string;
  notice: string;
  createdAt: number;
  expiresAt: number;
}

export type RotationPlanStatus = 'pending' | 'applied' | 'expired' | 'rejected';

export interface RotationPlan {
  id: string;
  sessionId: string;
  revision: number;
  createdAt: number;
  expiresAt: number;
  status: RotationPlanStatus;
  allowMixed: boolean;
  canMix: boolean;
  policy: {
    rotationMode: 'open' | 'skill-banded';
    avoidRepeatPartners: boolean;
  };
  assignments: Array<{
    courtId: number;
    courtName: string;
    players: Player[];
    mixed: boolean;
    metrics: {
      ratingDifference: number | null;
      repeatPartners: number;
      repeatOpponents: number;
    };
  }>;
  waiting: Player[];
  blockedReason: string | null;
}

export interface AppSnapshot {
  settings: ClubSettings;
  session: Session;
  sessions: Session[];
  roster: Player[];
  courts: Court[];
  holdingPool: Player[];
  nextGamePool: NextGamePool;
  gameHistory: GameHistory[];
  matchProposals: MatchProposal[];
  rotation: { requiredPlayers: 2 | 4; eligiblePlayerIds: string[]; needsMixedApproval: boolean;
    waitingBand: SkillLevel | null; missingPlayers: number };
}

export interface RosterImportRow {
  externalId: string;
  name: string;
  skillLevel: SkillLevel;
  skillRating: number | null;
  playStyle: PlayStyle;
}

export interface RosterImportPreview {
  source: string;
  revision?: number;
  rows: Array<RosterImportRow & {
    status: 'new' | 'existing' | 'conflict';
    message: string | null;
    current?: Pick<RosterImportRow, 'name' | 'skillLevel' | 'skillRating' | 'playStyle'>;
    canUpdate?: boolean;
  }>;
  newCount: number;
  existingCount: number;
  conflictCount: number;
  /** Known profiles that will join this session, including reviewable corrections. */
  enrollCount: number;
}

export type Destination =
  | { type: 'holding-pool'; index?: number | undefined }
  | { type: 'next-game-pool'; lane: QueueLane }
  | { type: 'court'; courtId: number };

export interface HoldingCandidate {
  id: string;
  skillLevel: SkillLevel;
  skillRating: number | null;
  playStyle: PlayStyle;
  createdAt: number;
}

export interface ProposalDraft {
  source: ProposalSource;
  playerIds: string[];
  notice: string;
  mixed?: boolean;
  contextRevision?: number;
}
