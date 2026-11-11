import type {
  AppSnapshot,
  Attendance,
  ClubSettings,
  Destination,
  MatchProposal,
  RotationPlan,
  SessionReport,
  DailyReport,
  PlayerDisplay,
  RosterImportPreview,
  RosterImportResult,
  RosterImportRow,
  RosterImportOptions,
  RosterMapping,
  SkillLevel,
  StagedGroupAssignment,
} from '../types/models';

export const OPERATOR_ACCESS_KEY_STORAGE_KEY = 'pickleball.operatorAccessKey';
export const API_REQUEST_TIMEOUT_MS = 15_000;

const activeRequests = new Set<AbortController>();

export const cancelPendingRequests = (): void => {
  for (const controller of activeRequests) controller.abort();
};

const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const PUBLIC_DEMO = import.meta.env.VITE_PUBLIC_DEMO === 'true';
const RECORDING_ACCESS_KEY = import.meta.env.DEV && import.meta.env.MODE === 'demo'
  ? (import.meta.env.VITE_DEMO_OPERATOR_ACCESS_KEY || '').trim()
  : '';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  accessKey: string;
  body?: unknown;
  responseType?: 'json' | 'text';
}

const getErrorMessage = (payload: unknown, fallback: string): string => {
  if (typeof payload === 'string' && payload.trim()) return payload;

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
    if (record.error && typeof record.error === 'object') {
      const nestedError = record.error as Record<string, unknown>;
      if (typeof nestedError.message === 'string' && nestedError.message.trim()) {
        return nestedError.message;
      }
    }
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
  }

  return fallback;
};

const request = async <T>(path: string, options: RequestOptions): Promise<T> => {
  const controller = new AbortController();
  activeRequests.add(controller);
  let timedOut = false;
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(timedOut
      ? 'Request timed out. Refresh to check the latest state.'
      : 'Request cancelled.'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_REQUEST_TIMEOUT_MS);

  try {
    const operation = async (): Promise<T> => {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          Accept: options.responseType === 'text' ? 'text/csv' : 'application/json',
          ...(options.accessKey ? { Authorization: `Bearer ${options.accessKey}` } : {}),
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const fallback = response.statusText || `Request failed with status ${response.status}`;
        throw new ApiError(getErrorMessage(payload, fallback), response.status);
      }

      return (options.responseType === 'text' ? response.text() : response.json()) as Promise<T>;
    };

    // Bound body parsing as well as fetch; cancellation must release the queue.
    return await Promise.race([operation(), cancelled]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    activeRequests.delete(controller);
  }
};

export const readOperatorAccessKey = (): string | null => {
  if (typeof sessionStorage !== 'undefined') {
    try {
      const storedAccessKey = sessionStorage.getItem(OPERATOR_ACCESS_KEY_STORAGE_KEY);
      if (storedAccessKey) return storedAccessKey;
    } catch {
      // Recording mode can still bootstrap when session storage is unavailable.
    }
  }

  return RECORDING_ACCESS_KEY || null;
};

export const storeOperatorAccessKey = (accessKey: string): void => {
  sessionStorage.setItem(OPERATOR_ACCESS_KEY_STORAGE_KEY, accessKey);
};

export const clearOperatorAccessKey = (): void => {
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem(OPERATOR_ACCESS_KEY_STORAGE_KEY);
    } catch {
      // The in-memory auth state is still cleared when storage is unavailable.
    }
  }
};

export const getAppState = (accessKey: string): Promise<AppSnapshot> =>
  request<AppSnapshot>('/api/state', { accessKey });

export const previewRosterImport = (
  accessKey: string,
  source: string,
  rows: RosterImportRow[],
): Promise<RosterImportPreview> =>
  request<RosterImportPreview>('/api/roster/preview', {
    method: 'POST',
    accessKey,
    body: { source, rows },
  });

export const importRoster = (
  accessKey: string,
  source: string,
  rows: RosterImportRow[],
  options: RosterImportOptions = {},
): Promise<RosterImportResult> =>
  request<RosterImportResult>('/api/roster/import', {
    method: 'POST',
    accessKey,
    body: { source, rows, ...options },
  });

export const setPlayerAttendance = (
  accessKey: string,
  playerId: string,
  attendance: Attendance,
): Promise<AppSnapshot> =>
  request<AppSnapshot>(`/api/players/${encodeURIComponent(playerId)}/attendance`, {
    method: 'POST',
    accessKey,
    body: { attendance },
  });

export const createPlayer = (
  accessKey: string,
  name: string,
  skillLevel: SkillLevel,
  skillRating: number | null,
  playStyle: string,
): Promise<AppSnapshot> =>
  request<AppSnapshot>('/api/players', {
    method: 'POST',
    accessKey,
    body: { name, skillLevel, skillRating, playStyle },
  });

export const removePlayer = (accessKey: string, playerId: string): Promise<AppSnapshot> =>
  request<AppSnapshot>(`/api/players/${encodeURIComponent(playerId)}`, {
    method: 'DELETE',
    accessKey,
  });

export const movePlayer = (
  accessKey: string,
  playerId: string,
  destination: Destination,
): Promise<AppSnapshot> =>
  request<AppSnapshot>(`/api/players/${encodeURIComponent(playerId)}/move`, {
    method: 'POST',
    accessKey,
    body: { destination },
  });

export const reorderHoldingPool = (
  accessKey: string,
  playerId: string,
  targetIndex: number,
): Promise<AppSnapshot> =>
  request<AppSnapshot>('/api/holding/reorder', {
    method: 'POST',
    accessKey,
    body: { playerId, targetIndex },
  });

export const startGame = (accessKey: string, courtId: number): Promise<AppSnapshot> =>
  request<AppSnapshot>(`/api/courts/${courtId}/start`, { method: 'POST', accessKey });

export const assignStagedGroup = (accessKey: string, courtId: number, group: StagedGroupAssignment): Promise<AppSnapshot> =>
  request<AppSnapshot>(`/api/courts/${courtId}/assign-staged`, { method: 'POST', accessKey, body: group });

export const endGame = (accessKey: string, courtId: number): Promise<AppSnapshot> =>
  request<AppSnapshot>(`/api/courts/${courtId}/end`, { method: 'POST', accessKey });

export const toggleCourtStatus = (accessKey: string, courtId: number): Promise<AppSnapshot> =>
  request<AppSnapshot>(`/api/courts/${courtId}/toggle`, { method: 'POST', accessKey });

export const requestMatchProposal = (accessKey: string, allowMixed = false): Promise<MatchProposal> =>
  request<MatchProposal>('/api/match-proposals', { method: 'POST', accessKey,
    ...(allowMixed ? { body: { allowMixed: true } } : {}),
  });

export const requestRotationPlan = (accessKey: string, allowMixed = false): Promise<RotationPlan> =>
  request<RotationPlan>('/api/rotation-plans', { method: 'POST', accessKey, body: { allowMixed } });

export const getCurrentRotationPlan = (accessKey: string): Promise<RotationPlan | null> =>
  request<RotationPlan | null>('/api/rotation-plans/current', { accessKey });

export const rejectRotationPlan = (
  accessKey: string,
  planId: string,
): Promise<Pick<RotationPlan, 'id' | 'status'>> =>
  request<Pick<RotationPlan, 'id' | 'status'>>(
    `/api/rotation-plans/${encodeURIComponent(planId)}/reject`,
    { method: 'POST', accessKey },
  );

export const applyRotationPlan = (accessKey: string, planId: string, approveMixed = false): Promise<AppSnapshot> =>
  request<AppSnapshot>(`/api/rotation-plans/${encodeURIComponent(planId)}/apply`, {
    method: 'POST', accessKey, body: { approveMixed },
  });

export const applyMatchProposal = (
  accessKey: string,
  proposalId: string,
  courtId?: number,
  approveMixed = false,
): Promise<AppSnapshot> =>
  request<AppSnapshot>(`/api/match-proposals/${encodeURIComponent(proposalId)}/apply`, {
    method: 'POST',
    accessKey,
    ...(courtId === undefined && !approveMixed ? {} : { body: { ...(courtId === undefined ? {} : { courtId }), ...(approveMixed ? { approveMixed: true } : {}) } }),
  });

export const rejectMatchProposal = (
  accessKey: string,
  proposalId: string,
): Promise<MatchProposal> =>
  request<MatchProposal>(`/api/match-proposals/${encodeURIComponent(proposalId)}/reject`, {
    method: 'POST',
    accessKey,
  });

export const createVisitorSession = (): Promise<{ accessKey: string; expiresAt: number }> =>
  request('/api/visitor-sessions', { method: 'POST', accessKey: '' });

export const resetVisitorSession = (accessKey: string): Promise<AppSnapshot> =>
  request('/api/visitor-reset', { method: 'POST', accessKey });

export const updateSettings = (accessKey: string, settings: ClubSettings): Promise<AppSnapshot> =>
  request('/api/settings', { method: 'POST', accessKey, body: settings });

export const startSession = (accessKey: string, name: string, includePreviousRoster = false): Promise<AppSnapshot> =>
  request('/api/sessions', { method: 'POST', accessKey, body: { name, ...(includePreviousRoster ? { includePreviousRoster: true } : {}) } });

export const closeSession = (accessKey: string): Promise<AppSnapshot> =>
  request('/api/sessions/close', { method: 'POST', accessKey });

export const getSessionReport = (accessKey: string, sessionId: string): Promise<SessionReport> =>
  request(`/api/sessions/${encodeURIComponent(sessionId)}/report`, { accessKey });

export const getDailyReport = (accessKey: string, date: string): Promise<DailyReport> =>
  request(`/api/reports/daily?${new URLSearchParams({ date })}`, { accessKey });

export const exportSession = (accessKey: string, kind: 'attendance' | 'matches', sessionId?: string): Promise<string> => {
  const query = new URLSearchParams({ kind, ...(sessionId ? { sessionId } : {}) });
  return request(`/api/sessions/export?${query}`, { accessKey, responseType: 'text' });
};

export const createDisplayAccess = (accessKey: string): Promise<{ accessKey: string; expiresAt: number }> =>
  request('/api/display-access', { method: 'POST', accessKey });

export const getPlayerDisplay = (accessKey: string): Promise<PlayerDisplay> =>
  request('/api/display', { accessKey });

export const voidActiveGame = (accessKey: string, courtId: number, reason: string): Promise<AppSnapshot> =>
  request(`/api/courts/${courtId}/void`, { method: 'POST', accessKey, body: { reason } });

export const voidRecordedGame = (accessKey: string, gameId: string, reason: string): Promise<AppSnapshot> =>
  request(`/api/games/${encodeURIComponent(gameId)}/void`, { method: 'POST', accessKey, body: { reason } });

export const correctRecordedGame = (accessKey: string, gameId: string, correction: { playerIds: string[]; durationSeconds: number; reason: string }): Promise<AppSnapshot> =>
  request(`/api/games/${encodeURIComponent(gameId)}/correct`, { method: 'POST', accessKey, body: correction });

export const saveRosterMapping = (accessKey: string, mapping: RosterMapping): Promise<AppSnapshot> =>
  request('/api/roster/mapping', { method: 'POST', accessKey, body: { mapping } });
