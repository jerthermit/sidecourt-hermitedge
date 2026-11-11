import { useEffect, useId, useRef, useState } from 'react';
import { AnimatedDialog } from './AnimatedDialog';
import type { Court, Player, QueueLane, StagedGroupAssignment } from '../types/models';

interface StagedGroupDialogProps {
  sessionId: string;
  lane: QueueLane;
  players: Player[];
  courts: Court[];
  playerCount: number;
  requireMixedApproval: boolean;
  stale: boolean;
  busy: boolean;
  error: string | null;
  onAssign: (courtId: number, group: StagedGroupAssignment) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}

export function StagedGroupDialog({ sessionId, lane, players, courts, playerCount, requireMixedApproval,
  stale, busy, error, onAssign, onRefresh, onClose }: StagedGroupDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const committedCourt = useRef<number | null>(null);
  const [courtId, setCourtId] = useState('');
  const [approveMixed, setApproveMixed] = useState(false);
  const available = courts.filter((court) => court.status === 'available' && court.players.length === 0);
  const selected = available.find((court) => String(court.id) === courtId);
  const currentCourt = courts.find((court) => String(court.id) === courtId);
  const invalidGroup = stale || players.length !== playerCount || new Set(players.map((player) => player.id)).size !== playerCount;

  useEffect(() => {
    const dialog = dialogRef.current;
    const origin = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      const target = committedCourt.current === null ? null
        : document.querySelector<HTMLElement>(`[data-court-id="${committedCourt.current}"] .court-card__footer .button--primary:not(:disabled)`);
      if (target) target.focus({ preventScroll: true });
      else if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true });
      else document.getElementById('next-game-title')?.focus({ preventScroll: true });
    };
  }, []);

  return <AnimatedDialog ref={dialogRef} className="dialog dialog--proposal" aria-labelledby={id}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog__header"><h2 id={id}>Assign group</h2>
      <button type="button" className="icon-button" aria-label="Close staged group review" disabled={busy} onClick={onClose}><span aria-hidden="true">×</span></button>
    </div>
    <form className="dialog__body proposal-body" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || error || invalidGroup || !selected || (requireMixedApproval && !approveMixed)) return;
      if (await onAssign(selected.id, { sessionId, lane, playerIds: players.map((player) => player.id), approveMixed })) {
        committedCourt.current = selected.id;
        onClose();
      }
    }}>
      {error ? <div className="inline-alert inline-alert--error" role="alert">{error}</div> : null}
      {invalidGroup ? <div className="inline-alert inline-alert--warning" role="status">Staged group changed. Refresh before assigning.</div> : null}
      <div className="proposal-teams">
        {[0, 1].map((team) => <section className="court-team" key={team}><h3>Team {team + 1}</h3>
          <ol className="proposal-roster" aria-label={`Staged team ${team + 1}`}>
            {players.slice(team * playerCount / 2, (team + 1) * playerCount / 2).map((player) => <li key={player.id}>
              <span>{player.name}<small className="proposal-player-level">{player.skillLevel}</small></span>
              <small aria-label={player.skillRating === null ? 'Local rating not recorded' : undefined}>{player.skillRating?.toFixed(1) ?? '—'}</small>
            </li>)}
          </ol>
        </section>)}
      </div>
      {available.length > 0 || courtId ? <label className="form-field"><span>Court</span>
        <select required value={courtId} onChange={(event) => setCourtId(event.target.value)} disabled={busy}>
          <option value="">Choose court</option>
          {courtId && !selected ? <option value={courtId} disabled>{currentCourt?.name ?? `Court ${courtId}`} — unavailable</option> : null}
          {available.map((court) => <option key={court.id} value={court.id}>{court.name ?? `Court ${court.id}`}</option>)}
        </select>
      </label> : <p className="queue-policy" role="status">No empty court available.</p>}
      {requireMixedApproval ? <label className="checkbox-field mixed-approval">
        <input type="checkbox" checked={approveMixed} onChange={(event) => setApproveMixed(event.target.checked)} disabled={busy} />
        <span>Allow mixed levels</span>
      </label> : null}
      {courtId && !selected ? <p className="field-error" role="status">{available.length > 0 ? 'Choose another court.' : 'No empty courts.'}</p> : null}
      <div className="dialog__actions">
        <button type="button" className="button button--secondary" disabled={busy} onClick={onClose}>Cancel</button>
        {error || invalidGroup ? <button type="button" className="button button--primary" disabled={busy} onClick={() => void onRefresh()}>Refresh group</button>
          : <button type="submit" className="button button--primary" disabled={busy || !selected || invalidGroup || (requireMixedApproval && !approveMixed)}>{busy ? 'Assigning…' : 'Assign court'}</button>}
      </div>
    </form>
  </AnimatedDialog>;
}
