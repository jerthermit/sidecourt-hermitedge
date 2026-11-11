import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { AnimatedDialog } from './AnimatedDialog';
import type { GameHistory, Player } from '../types/models';
import { ReasonDialog } from './ReasonDialog';
import { historyIdentities } from '../lib/board';

interface Correction { playerIds: string[]; durationSeconds: number; reason: string }
interface CourtHistoryProps {
  courtId: number;
  courtName?: string;
  history: GameHistory[];
  identityHistory?: GameHistory[];
  roster?: Player[];
  sessionId?: string;
  sessionOpen?: boolean;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onClearError?: () => void;
  timezone?: string;
  onVoid?: (gameId: string, reason: string) => Promise<boolean>;
  onCorrect?: (gameId: string, correction: Correction) => Promise<boolean>;
}

const formatStartedAt = (epochMs: number, timezone: string): string => new Intl.DateTimeFormat('en-AU', {
  timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(epochMs);
const formatDuration = (seconds: number): string => `${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, '0')}s`;

export function CourtHistory({ courtId, courtName = `Court ${courtId}`, history, roster = [], sessionId,
  sessionOpen = false, busy = false, error = null, onClose, onClearError, timezone = 'Australia/Sydney', onVoid, onCorrect,
  identityHistory = history,
}: CourtHistoryProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [action, setAction] = useState<{ kind: 'void' | 'correct'; game: GameHistory } | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const origin = document.activeElement;
    dialog?.showModal();
    closeRef.current?.focus();
    return () => {
      dialog?.close();
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true });
    };
  }, []);
  const closeAction = () => { setAction(null); onClearError?.(); };
  return <>
    <AnimatedDialog ref={dialogRef} className="dialog dialog--history" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <div className="dialog__header"><h2 id={titleId}>{courtName} history</h2><button ref={closeRef} type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close match history"><span aria-hidden="true">×</span></button></div>
      <div className="dialog__body dialog__body--scroll">
        {history.length === 0 ? <div className="empty-state"><p>No matches yet.</p></div> : <ol className="match-records">
          {history.map((game) => {
            const editable = sessionOpen && game.sessionId === sessionId && game.status !== 'voided';
            const identified = game.playerIds?.length === game.players.length && (game.playerIds.length === 2 || game.playerIds.length === 4);
            return <li className={`match-record ${game.status === 'voided' ? 'match-record--voided' : ''}`} key={game.id}>
              <div className="match-record__meta"><time dateTime={new Date(game.startedAt).toISOString()}>{formatStartedAt(game.startedAt, timezone)}</time><span>{formatDuration(game.duration)}</span><span className={`record-status record-status--${game.status ?? 'completed'}`}>{game.status === 'voided' ? 'Voided' : game.correctedAt ? 'Corrected' : 'Completed'}</span></div>
              <p className="match-record__names">{game.players.join(', ')}</p>
              {game.reason ? <p className="match-record__reason">{game.reason}</p> : null}
              {editable && (onVoid || onCorrect) ? <div className="match-record__actions">
                {onCorrect ? <button type="button" className="button button--secondary button--small" disabled={busy || !identified} title={!identified ? 'Original player identities are not recorded' : undefined} onClick={() => { onClearError?.(); setAction({ kind: 'correct', game }); }}>Correct</button> : null}
                {onVoid ? <button type="button" className="button button--ghost button--small" disabled={busy} onClick={() => { onClearError?.(); setAction({ kind: 'void', game }); }}>Void</button> : null}
              </div> : null}
            </li>;
          })}
        </ol>}
      </div>
    </AnimatedDialog>
    <AnimatePresence propagate>
      {action?.kind === 'void' && onVoid ? <ReasonDialog key={`void-${action.game.id}`} title="Void recorded match" message="The record is kept. Its games and time will be removed from session counts." busy={busy} error={error} onClose={closeAction} onConfirm={(reason) => onVoid(action.game.id, reason)} /> : null}
      {action?.kind === 'correct' && onCorrect ? <MatchCorrectionDialog key={`correct-${action.game.id}`} game={action.game} identities={historyIdentities(roster, identityHistory)} busy={busy} error={error} onClose={closeAction} onSave={(correction) => onCorrect(action.game.id, correction)} /> : null}
    </AnimatePresence>
  </>;
}

interface MatchCorrectionDialogProps {
  game: GameHistory;
  identities: Array<{ id: string; name: string }>;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (correction: Correction) => Promise<boolean>;
}

export function MatchCorrectionDialog({ game, identities, busy, error, onClose, onSave }: MatchCorrectionDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [playerIds, setPlayerIds] = useState(game.playerIds ?? []);
  const [minutes, setMinutes] = useState(String(Math.floor(game.duration / 60)));
  const [seconds, setSeconds] = useState(String(game.duration % 60));
  const [reason, setReason] = useState('');
  useEffect(() => {
    const dialog = dialogRef.current;
    const origin = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true });
    };
  }, []);
  const durationSeconds = Number(minutes) * 60 + Number(seconds);
  const duplicate = new Set(playerIds).size !== playerIds.length;
  const valid = playerIds.every(Boolean) && !duplicate && minutes !== '' && seconds !== ''
    && Number.isInteger(Number(minutes)) && Number.isInteger(Number(seconds)) && Number(minutes) >= 0 && Number(seconds) >= 0
    && Number(seconds) < 60 && durationSeconds <= 86400 && reason.trim().length >= 3;
  const ambiguousNames = new Set(identities.filter((item, index) => identities.some((other, otherIndex) => otherIndex !== index && item.name === other.name)).map((item) => item.name));
  return <AnimatedDialog ref={dialogRef} className="dialog dialog--small" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog__header"><h2 id={titleId}>Correct match</h2><button type="button" className="icon-button" aria-label="Close match correction" disabled={busy} onClick={onClose}><span aria-hidden="true">×</span></button></div>
    <form className="dialog__body form-stack" onSubmit={async (event) => { event.preventDefault(); if (valid && await onSave({ playerIds, durationSeconds, reason: reason.trim() })) onClose(); }}>
      {error ? <div className="inline-alert inline-alert--error" role="alert">{error}</div> : null}
      <fieldset className="correction-players"><legend>Players</legend>{playerIds.map((playerId, index) => <label className="form-field" key={index}><span>Team {index < playerIds.length / 2 ? 1 : 2} · Player {index % (playerIds.length / 2) + 1}</span><select value={playerId} onChange={(event) => setPlayerIds(playerIds.map((id, position) => position === index ? event.target.value : id))} disabled={busy} required>{identities.map((identity) => <option value={identity.id} key={identity.id}>{identity.name}{ambiguousNames.has(identity.name) ? ` · ${identity.id.slice(-6)}` : ''}</option>)}</select></label>)}</fieldset>
      {duplicate ? <p className="field-error" role="alert">Select each player once.</p> : null}
      <fieldset className="correction-duration"><legend>Duration</legend><label className="form-field"><span>Minutes</span><input type="number" min="0" max="1440" step="1" required value={minutes} onChange={(event) => setMinutes(event.target.value)} disabled={busy} /></label><label className="form-field"><span>Seconds</span><input type="number" min="0" max="59" step="1" required value={seconds} onChange={(event) => setSeconds(event.target.value)} disabled={busy} /></label></fieldset>
      <label className="field"><span>Reason</span><textarea required minLength={3} maxLength={160} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} /></label>
      <div className="dialog__actions"><button type="button" className="button button--secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button button--primary" disabled={busy || !valid}>{busy ? 'Saving…' : 'Save correction'}</button></div>
    </form>
  </AnimatedDialog>;
}
