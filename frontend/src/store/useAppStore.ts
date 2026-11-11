import { create } from 'zustand';
import * as api from '../lib/api';
import type {
  AppSnapshot,
  Attendance,
  ClubSettings,
  Destination,
  GameHistory,
  MatchProposal,
  RotationPlan,
  RosterImportPreview,
  RosterImportResult,
  RosterImportRow,
  RosterImportOptions,
  RosterMapping,
  SkillLevel,
  SessionReport,
  DailyReport,
  StagedGroupAssignment,
} from '../types/models';

type BusyKind = 'loading' | 'saving' | 'proposal';

interface AppActions {
  initialize: () => Promise<boolean>;
  reload: () => Promise<boolean>;
  setAccessKey: (accessKey: string) => void;
  logout: () => void;
  clearError: () => void;
  clearRosterImport: () => void;
  previewRosterImport: (source: string, rows: RosterImportRow[]) => Promise<boolean>;
  importRoster: (source: string, rows: RosterImportRow[], options?: RosterImportOptions) => Promise<boolean>;
  setPlayerAttendance: (playerId: string, attendance: Attendance) => Promise<boolean>;
  addPlayer: (
    name: string,
    skillLevel: SkillLevel,
    skillRating: number | null,
    playStyle: string,
  ) => Promise<boolean>;
  removePlayer: (playerId: string) => Promise<boolean>;
  movePlayer: (playerId: string, destination: Destination) => Promise<boolean>;
  reorderHoldingPool: (fromIndex: number, toIndex: number) => Promise<boolean>;
  startGame: (courtId: number) => Promise<boolean>;
  assignStagedGroup: (courtId: number, group: StagedGroupAssignment) => Promise<boolean>;
  endGame: (courtId: number) => Promise<boolean>;
  endGameAndReview: (courtId: number) => Promise<boolean>;
  toggleCourtStatus: (courtId: number) => Promise<boolean>;
  requestMatchProposal: (allowMixed?: boolean, courtId?: number) => Promise<boolean>;
  applyMatchProposal: (courtId?: number, approveMixed?: boolean) => Promise<boolean>;
  requestRotationPlan: (allowMixed?: boolean) => Promise<boolean>;
  applyRotationPlan: (approveMixed?: boolean) => Promise<boolean>;
  dismissRotationPlan: () => Promise<boolean>;
  clearRotationPlan: () => void;
  voidActiveGame: (courtId: number, reason: string) => Promise<boolean>;
  voidRecordedGame: (gameId: string, reason: string) => Promise<boolean>;
  correctRecordedGame: (gameId: string, correction: { playerIds: string[]; durationSeconds: number; reason: string }) => Promise<boolean>;
  saveRosterMapping: (mapping: RosterMapping) => Promise<boolean>;
  updateSettings: (settings: ClubSettings) => Promise<boolean>;
  startSession: (name: string, includePreviousRoster?: boolean) => Promise<boolean>;
  closeSession: () => Promise<boolean>;
  resetVisitorSession: () => Promise<boolean>;
  exportSession: (kind: 'attendance' | 'matches', sessionId?: string) => Promise<boolean>;
  loadSessionReport: (sessionId: string) => Promise<SessionReport | null>;
  loadDailyReport: (date: string) => Promise<DailyReport | null>;
  createPlayerView: () => Promise<string | null>;
  rejectMatchProposal: () => Promise<boolean>;
  dismissMatchProposal: () => Promise<boolean>;
  updateCourtTimer: (courtId: number) => void;
  getCourtHistory: (courtId: number) => GameHistory[];
}

export interface AppStore extends AppSnapshot, AppActions {
  accessKey: string | null;
  authRequired: boolean;
  isLoading: boolean;
  isSaving: boolean;
  isProposalLoading: boolean;
  error: string | null;
  matchProposal: MatchProposal | null;
  matchProposalCourtId: number | null;
  rotationPlan: RotationPlan | null;
  rosterImportPreview: RosterImportPreview | null;
  rosterImportResult: Pick<RosterImportResult, 'added' | 'skipped' | 'updated' | 'enrolled'> | null;
}

const emptySnapshot = (): AppSnapshot => ({
  roster: [],
  courts: [],
  holdingPool: [],
  nextGamePool: {
    beginner: [],
    intermediate: [],
    advanced: [],
    mixed: [],
  },
  gameHistory: [],
  matchProposals: [],
  settings: undefined,
  session: undefined,
  sessions: [],
  rotation: undefined,
});

const snapshotFields = (snapshot: AppSnapshot): AppSnapshot => ({
  roster: snapshot.roster,
  courts: snapshot.courts,
  holdingPool: snapshot.holdingPool,
  nextGamePool: snapshot.nextGamePool,
  gameHistory: snapshot.gameHistory,
  matchProposals: snapshot.matchProposals ?? [],
  settings: snapshot.settings,
  session: snapshot.session,
  sessions: snapshot.sessions ?? [],
  rotation: snapshot.rotation,
});

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Couldn’t complete that. Try again.';
};

const isAuthenticationError = (error: unknown): boolean =>
  error instanceof api.ApiError && (error.status === 401 || error.status === 403);

const initialAccessKey = api.readOperatorAccessKey();

export const useAppStore = create<AppStore>((set, get) => {
  let operationQueue: Promise<void> = Promise.resolve();
  let authRevision = 0;
  let pendingLoads = 0;
  let pendingSaves = 0;
  let pendingProposals = 0;
  const resolvedProposalIds = new Set<string>();
  const pendingCourtHandoffs = new Map<number, Promise<boolean>>();
  let visitorBootstrap: Promise<boolean> | null = null;

  const setBusy = (kind: BusyKind, delta: 1 | -1): void => {
    if (kind === 'loading') pendingLoads = Math.max(0, pendingLoads + delta);
    if (kind === 'saving') pendingSaves = Math.max(0, pendingSaves + delta);
    if (kind === 'proposal') pendingProposals = Math.max(0, pendingProposals + delta);

    set({
      isLoading: pendingLoads > 0,
      isSaving: pendingSaves > 0,
      isProposalLoading: pendingProposals > 0,
    });
  };

  const requireAccessKey = (): string | null => {
    const accessKey = get().accessKey;
    if (accessKey) return accessKey;

    set({
      authRequired: true,
      error: 'Operator code required.',
    });
    return null;
  };

  const invalidateAuth = (): void => {
    authRevision += 1;
    api.cancelPendingRequests();
    pendingLoads = 0;
    pendingSaves = 0;
    pendingProposals = 0;
    resolvedProposalIds.clear();
    pendingCourtHandoffs.clear();
    set({ isLoading: false, isSaving: false, isProposalLoading: false, matchProposalCourtId: null, rotationPlan: null });
  };

  const snapshotUpdate = (snapshot: AppSnapshot) => {
    const fields = snapshotFields(snapshot);
    const matchProposals = (fields.matchProposals ?? []).filter((proposal) =>
      proposal.status === 'pending'
      && proposal.expiresAt > Date.now()
      && !resolvedProposalIds.has(proposal.id),
    );
    const current = get().matchProposal;
    const retained = current?.status === 'pending'
      ? matchProposals.find((proposal) => proposal.id === current.id) ?? null
      : current?.status === 'expired' ? null : current;
    const matchProposal = retained ?? matchProposals[0] ?? null;

    return {
      ...fields,
      matchProposals,
      // The server returns pending proposals newest first.
      matchProposal,
      matchProposalCourtId: current && matchProposal?.id === current.id ? get().matchProposalCourtId : null,
    };
  };

  const handleFailure = (error: unknown, revision: number): void => {
    if (revision !== authRevision) return;

    if (isAuthenticationError(error)) {
      api.clearOperatorAccessKey();
      invalidateAuth();
      set({
        ...emptySnapshot(),
        accessKey: null,
        authRequired: true,
        matchProposal: null,
        rosterImportPreview: null,
        rosterImportResult: null,
        error: api.PUBLIC_DEMO ? 'Session expired. Start again.' : 'Invalid operator code.',
      });
      return;
    }

    set({ error: errorMessage(error) });
  };

  const enqueue = <T>(
    kind: BusyKind,
    request: (accessKey: string) => Promise<T>,
    commit: (value: T) => void,
  ): Promise<boolean> => {
    const accessKey = requireAccessKey();
    if (!accessKey) return Promise.resolve(false);

    const revision = authRevision;
    setBusy(kind, 1);
    set({ error: null });

    const task = operationQueue.then(async () => {
      try {
        if (revision !== authRevision) return false;

        const value = await request(accessKey);
        if (revision !== authRevision) return false;

        commit(value);
        set({ authRequired: false, error: null });
        return true;
      } catch (error) {
        handleFailure(error, revision);
        return false;
      } finally {
        if (revision === authRevision) setBusy(kind, -1);
      }
    });

    operationQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  const loadBoard = (revision: number) => enqueue(
    'loading',
    async (accessKey) => {
      const snapshot = await api.getAppState(accessKey);
      if (revision !== authRevision) return null;
      const currentPlan = await api.getCurrentRotationPlan(accessKey);
      if (revision !== authRevision) return null;
      const rotationPlan = currentPlan?.status === 'pending'
        && currentPlan.expiresAt > Date.now()
        && currentPlan.sessionId === snapshot.session?.id
        && snapshot.session?.endedAt === null
        ? currentPlan
        : null;
      return { snapshot, rotationPlan };
    },
    (result) => {
      if (result) set({ ...snapshotUpdate(result.snapshot), rotationPlan: result.rotationPlan });
    },
  );

  const loadSnapshot = (): Promise<boolean> => {
    const storedAccessKey = api.readOperatorAccessKey();

    if (!storedAccessKey) {
      if (api.PUBLIC_DEMO) {
        if (visitorBootstrap) return visitorBootstrap;
        const revision = authRevision;
        setBusy('loading', 1);
        set({ authRequired: false, error: null });
        visitorBootstrap = (async () => {
          try {
            const visitor = await api.createVisitorSession();
            if (revision !== authRevision) return false;
            get().setAccessKey(visitor.accessKey);
            if (!get().accessKey) return false;
            return await loadBoard(authRevision);
          } catch (error) {
            handleFailure(error, revision);
            return false;
          } finally {
            if (revision === authRevision) setBusy('loading', -1);
            visitorBootstrap = null;
          }
        })();
        return visitorBootstrap;
      }
      invalidateAuth();
      set({
        ...emptySnapshot(),
        accessKey: null,
        authRequired: true,
        matchProposal: null,
        rosterImportPreview: null,
        rosterImportResult: null,
        error: null,
      });
      return Promise.resolve(false);
    }

    if (storedAccessKey !== get().accessKey) {
      invalidateAuth();
      set({
        ...emptySnapshot(),
        accessKey: storedAccessKey,
        authRequired: false,
        matchProposal: null,
        rosterImportPreview: null,
        rosterImportResult: null,
        error: null,
      });
    }

    return loadBoard(authRevision);
  };

  return {
    ...emptySnapshot(),
    accessKey: initialAccessKey,
    authRequired: !initialAccessKey && !api.PUBLIC_DEMO,
    isLoading: false,
    isSaving: false,
    isProposalLoading: false,
    error: null,
    matchProposal: null,
    matchProposalCourtId: null,
    rotationPlan: null,
    rosterImportPreview: null,
    rosterImportResult: null,

    initialize: loadSnapshot,
    reload: loadSnapshot,

    setAccessKey: (value) => {
      const accessKey = value.trim();
      if (!accessKey) {
        api.clearOperatorAccessKey();
        invalidateAuth();
        set({
          ...emptySnapshot(),
          accessKey: null,
          authRequired: true,
          matchProposal: null,
          rosterImportPreview: null,
          rosterImportResult: null,
          error: 'Operator code required.',
        });
        return;
      }

      try {
        api.storeOperatorAccessKey(accessKey);
      } catch (error) {
        invalidateAuth();
        set({
          ...emptySnapshot(),
          accessKey: null,
          authRequired: true,
          matchProposal: null,
          rosterImportPreview: null,
          rosterImportResult: null,
          error: `Couldn’t save the operator code: ${errorMessage(error)}`,
        });
        return;
      }

      const changedOperator = accessKey !== get().accessKey;
      if (changedOperator) invalidateAuth();

      set({
        ...(changedOperator ? emptySnapshot() : {}),
        accessKey,
        authRequired: false,
        matchProposal: changedOperator ? null : get().matchProposal,
        rosterImportPreview: changedOperator ? null : get().rosterImportPreview,
        rosterImportResult: changedOperator ? null : get().rosterImportResult,
        error: null,
      });
    },

    logout: () => {
      api.clearOperatorAccessKey();
      invalidateAuth();
      set({
        ...emptySnapshot(),
        accessKey: null,
        authRequired: true,
        matchProposal: null,
        rosterImportPreview: null,
        rosterImportResult: null,
        error: null,
        isLoading: false,
        isSaving: false,
        isProposalLoading: false,
      });
    },

    clearError: () => set({ error: null }),

    clearRosterImport: () => set({ rosterImportPreview: null, rosterImportResult: null }),

    previewRosterImport: (source, rows) =>
      enqueue(
        'saving',
        (accessKey) => api.previewRosterImport(accessKey, source, rows),
        (preview) => set({ rosterImportPreview: preview, rosterImportResult: null }),
      ),

    importRoster: (source, rows, options) =>
      enqueue(
        'saving',
        (accessKey) => options ? api.importRoster(accessKey, source, rows, options) : api.importRoster(accessKey, source, rows),
        ({ snapshot, added, skipped, updated, enrolled }) => set({
          ...snapshotUpdate(snapshot),
          rosterImportPreview: null,
          rosterImportResult: { added, skipped, ...(updated !== undefined ? { updated } : {}), ...(enrolled !== undefined ? { enrolled } : {}) },
        }),
      ),

    setPlayerAttendance: (playerId, attendance) =>
      enqueue(
        'saving',
        (accessKey) => api.setPlayerAttendance(accessKey, playerId, attendance),
        (snapshot) => set(snapshotUpdate(snapshot)),
      ),

    addPlayer: (name, skillLevel, skillRating, playStyle) =>
      enqueue(
        'saving',
        (accessKey) => api.createPlayer(accessKey, name, skillLevel, skillRating, playStyle),
        (snapshot) => set(snapshotUpdate(snapshot)),
      ),

    removePlayer: (playerId) =>
      enqueue(
        'saving',
        (accessKey) => api.removePlayer(accessKey, playerId),
        (snapshot) => set(snapshotUpdate(snapshot)),
      ),

    movePlayer: (playerId, destination) =>
      enqueue(
        'saving',
        (accessKey) => api.movePlayer(accessKey, playerId, destination),
        (snapshot) => set(snapshotUpdate(snapshot)),
      ),

    reorderHoldingPool: (fromIndex, toIndex) => {
      const player = get().holdingPool[fromIndex];
      if (!player) {
        set({ error: 'Player is no longer waiting. Refresh.' });
        return Promise.resolve(false);
      }

      return enqueue(
        'saving',
        (accessKey) => api.reorderHoldingPool(accessKey, player.id, toIndex),
        (snapshot) => set(snapshotUpdate(snapshot)),
      );
    },

    assignStagedGroup: (courtId, group) =>
      enqueue('saving', (key) => api.assignStagedGroup(key, courtId, group), (snapshot) => set(snapshotUpdate(snapshot))),

    startGame: (courtId) =>
      enqueue(
        'saving',
        (accessKey) => api.startGame(accessKey, courtId),
        (snapshot) => set(snapshotUpdate(snapshot)),
      ),

    endGame: (courtId) =>
      enqueue(
        'saving',
        (accessKey) => api.endGame(accessKey, courtId),
        (snapshot) => set(snapshotUpdate(snapshot)),
      ),

    endGameAndReview: (courtId) => {
      const pending = pendingCourtHandoffs.get(courtId);
      if (pending) return pending;

      const revision = authRevision;
      const task = enqueue('saving', async (accessKey) => {
        const snapshot = await api.endGame(accessKey, courtId);
        if (revision !== authRevision) return;

        set({ ...snapshotUpdate(snapshot), authRequired: false, error: null });
        if (revision !== authRevision) return;

        const court = snapshot.courts.find((item) => item.id === courtId);
        const rotation = snapshot.rotation;
        if (!rotation || rotation.eligiblePlayerIds.length < rotation.requiredPlayers
          || rotation.needsMixedApproval || !court || court.status !== 'available' || court.players.length > 0
          || snapshot.session?.endedAt !== null) return;

        setBusy('proposal', 1);
        try {
          if (revision !== authRevision) return;
          const proposal = await api.requestMatchProposal(accessKey, false);
          if (revision !== authRevision) return;
          set({
            matchProposal: proposal,
            matchProposalCourtId: courtId,
            matchProposals: [proposal, ...(get().matchProposals ?? []).filter((item) => item.id !== proposal.id)],
          });
        } catch (error) {
          if (isAuthenticationError(error)) throw error;
          throw new Error(`Match ended. ${errorMessage(error)}`);
        } finally {
          if (revision === authRevision) setBusy('proposal', -1);
        }
      }, () => undefined);

      if (revision === authRevision) pendingCourtHandoffs.set(courtId, task);
      void task.finally(() => {
        if (pendingCourtHandoffs.get(courtId) === task) pendingCourtHandoffs.delete(courtId);
      });
      return task;
    },

    toggleCourtStatus: (courtId) =>
      enqueue(
        'saving',
        (accessKey) => api.toggleCourtStatus(accessKey, courtId),
        (snapshot) => set(snapshotUpdate(snapshot)),
      ),

    requestMatchProposal: (allowMixed = false, courtId) =>
      enqueue('proposal', (key) => api.requestMatchProposal(key, allowMixed), (proposal) => {
        set({
          matchProposal: proposal,
          matchProposalCourtId: courtId ?? null,
          matchProposals: [proposal, ...(get().matchProposals ?? []).filter((item) => item.id !== proposal.id)],
        });
      }),

    requestRotationPlan: (allowMixed = false) => {
      const revision = authRevision;
      return enqueue('proposal', async (key) => {
        const snapshot = await api.getAppState(key);
        if (revision !== authRevision) return null;
        const plan = await api.requestRotationPlan(key, allowMixed);
        return { snapshot, plan };
      }, (result) => {
        if (result) set({ ...snapshotUpdate(result.snapshot), rotationPlan: result.plan, matchProposal: null, matchProposalCourtId: null });
      });
    },

    applyRotationPlan: (approveMixed = false) => {
      const plan = get().rotationPlan;
      if (!plan || plan.status !== 'pending' || plan.expiresAt <= Date.now()) {
        set({ error: 'Refresh the rotation before assigning courts.' });
        return Promise.resolve(false);
      }
      return enqueue('saving', (key) => api.applyRotationPlan(key, plan.id, approveMixed),
        (snapshot) => set({ ...snapshotUpdate(snapshot), rotationPlan: null }));
    },

    dismissRotationPlan: () => {
      const plan = get().rotationPlan;
      if (!plan) {
        set({ rotationPlan: null });
        return Promise.resolve(true);
      }
      return enqueue('saving', (key) => api.rejectRotationPlan(key, plan.id), () => {
        if (get().rotationPlan?.id === plan.id) set({ rotationPlan: null });
      });
    },

    clearRotationPlan: () => set({ rotationPlan: null }),

    applyMatchProposal: (courtId, approveMixed = false) => {
      const proposal = get().matchProposal;
      if (!proposal || proposal.status !== 'pending') {
        set({ error: 'No active match.' });
        return Promise.resolve(false);
      }

      return enqueue(
        'saving',
        (accessKey) => api.applyMatchProposal(accessKey, proposal.id, courtId, approveMixed),
        (snapshot) => {
          resolvedProposalIds.add(proposal.id);
          set({
            ...snapshotUpdate(snapshot),
            matchProposal: { ...proposal, status: 'applied' },
            matchProposalCourtId: null,
          });
        },
      );
    },

    updateSettings: (settings) =>
      enqueue('saving', (key) => api.updateSettings(key, settings), (snapshot) => set(snapshotUpdate(snapshot))),

    voidActiveGame: (courtId, reason) =>
      enqueue('saving', (key) => api.voidActiveGame(key, courtId, reason), (snapshot) => set(snapshotUpdate(snapshot))),

    voidRecordedGame: (gameId, reason) =>
      enqueue('saving', (key) => api.voidRecordedGame(key, gameId, reason), (snapshot) => set(snapshotUpdate(snapshot))),

    correctRecordedGame: (gameId, correction) =>
      enqueue('saving', (key) => api.correctRecordedGame(key, gameId, correction), (snapshot) => set(snapshotUpdate(snapshot))),

    saveRosterMapping: (mapping) =>
      enqueue('saving', (key) => api.saveRosterMapping(key, mapping), (snapshot) => set(snapshotUpdate(snapshot))),

    startSession: (name, includePreviousRoster = false) =>
      enqueue('saving', (key) => includePreviousRoster ? api.startSession(key, name, true) : api.startSession(key, name), (snapshot) => set({ ...snapshotUpdate(snapshot), rotationPlan: null, rosterImportPreview: null, rosterImportResult: null })),

    closeSession: () =>
      enqueue('saving', api.closeSession, (snapshot) => set({ ...snapshotUpdate(snapshot), matchProposal: null, matchProposalCourtId: null, rotationPlan: null })),

    resetVisitorSession: () =>
      enqueue('saving', api.resetVisitorSession, (snapshot) => {
        resolvedProposalIds.clear();
        set({ ...snapshotUpdate(snapshot), matchProposal: null, matchProposalCourtId: null, rotationPlan: null, rosterImportPreview: null, rosterImportResult: null });
      }),

    exportSession: (kind, sessionId) =>
      enqueue('saving', (key) => api.exportSession(key, kind, sessionId), (csv) => {
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${kind}-${sessionId ?? get().session?.id ?? 'session'}.csv`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),

    loadSessionReport: async (sessionId) => {
      let report: SessionReport | null = null;
      const success = await enqueue('loading', (key) => api.getSessionReport(key, sessionId), (result) => { report = result; });
      return success ? report : null;
    },

    loadDailyReport: async (date) => {
      let report: DailyReport | null = null;
      const success = await enqueue('loading', (key) => api.getDailyReport(key, date), (result) => { report = result; });
      return success ? report : null;
    },

    createPlayerView: async () => {
      let url: string | null = null;
      const success = await enqueue('saving', api.createDisplayAccess, (result) => {
        const target = new URL(window.location.href);
        target.hash = new URLSearchParams({ display: result.accessKey }).toString();
        url = target.toString();
      });
      return success ? url : null;
    },

    rejectMatchProposal: () => {
      const proposal = get().matchProposal;
      if (!proposal || proposal.status !== 'pending') {
        set({ error: 'No active match.' });
        return Promise.resolve(false);
      }

      return enqueue(
        'proposal',
        async (accessKey) => {
          try {
            const rejectedProposal = await api.rejectMatchProposal(accessKey, proposal.id);
            return { rejectedProposal, snapshot: null };
          } catch (error) {
            if (!(error instanceof api.ApiError) || (error.status !== 404 && error.status !== 409)) {
              throw error;
            }

            const snapshot = await api.getAppState(accessKey);
            const stillPending = (snapshot.matchProposals ?? []).some((item) =>
              item.id === proposal.id && item.status === 'pending' && item.expiresAt > Date.now(),
            );
            if (stillPending) throw error;
            return { rejectedProposal: null, snapshot };
          }
        },
        ({ rejectedProposal, snapshot }) => {
          resolvedProposalIds.add(proposal.id);
          if (snapshot) {
            set({ ...snapshotUpdate(snapshot), matchProposalCourtId: null });
          } else {
            set({
              matchProposal: rejectedProposal,
              matchProposalCourtId: null,
              matchProposals: (get().matchProposals ?? []).filter((item) => item.id !== proposal.id),
            });
          }
        },
      );
    },

    dismissMatchProposal: async () => {
      const proposal = get().matchProposal;
      if (!proposal) {
        set({ matchProposalCourtId: null });
        return true;
      }

      if (proposal.status === 'pending' && proposal.expiresAt > Date.now()) {
        const rejected = await get().rejectMatchProposal();
        if (!rejected) return false;
      }

      resolvedProposalIds.add(proposal.id);
      if (get().matchProposal?.id === proposal.id) {
        set({
          matchProposal: null,
          matchProposalCourtId: null,
          matchProposals: (get().matchProposals ?? []).filter((item) => item.id !== proposal.id),
        });
      }
      return true;
    },

    updateCourtTimer: (courtId) => {
      const now = Date.now();
      set((state) => ({
        courts: state.courts.map((court) => {
          if (court.id !== courtId || court.status !== 'in-play' || court.gameStartedAt === null) {
            return court;
          }

          return {
            ...court,
            timeElapsed: Math.max(0, Math.floor((now - court.gameStartedAt) / 1000)),
          };
        }),
      }));
    },

    getCourtHistory: (courtId) =>
      get().gameHistory.filter((record) => record.courtId === courtId),
  };
});
