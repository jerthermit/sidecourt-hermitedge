import React, { useEffect, useId, useRef, useState } from 'react';
import { AnimatedDialog } from './AnimatedDialog';
import type { Court, MatchProposal } from '../types/models';

interface MatchProposalModalProps {
  returnFocusTo?: HTMLElement | null;
  proposal: MatchProposal;
  error: string | null;
  isSaving: boolean;
  isProposalLoading: boolean;
  onApprove: (courtId?: number, approveMixed?: boolean) => Promise<boolean>;
  courts?: Court[];
  playerCount?: number;
  preferredCourtId?: number;
  onDismiss: () => Promise<boolean>;
  onRequestAnother: () => Promise<boolean>;
}

export const MatchProposalModal: React.FC<MatchProposalModalProps> = ({
  returnFocusTo,
  proposal,
  error,
  isSaving,
  isProposalLoading,
  onApprove,
  onDismiss,
  onRequestAnother,
  courts = [],
  playerCount = 4,
  preferredCourtId,
}) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const originRef = useRef(returnFocusTo);
  const returnCourtRef = useRef(preferredCourtId);
  const [now, setNow] = useState<number | null>(null);
  const availableCourts = courts.filter((court) => court.status === 'available' && court.players.length === 0);
  const [courtId, setCourtId] = useState<number | undefined>(() => preferredCourtId ?? availableCourts[0]?.id);
  const [mixedApproval, setMixedApproval] = useState(false);
  const selectedCourtAvailable = courtId === undefined || availableCourts.some((court) => court.id === courtId);

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocusTo = originRef.current ?? document.activeElement;
    const returnCourtId = returnCourtRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (returnFocusTo instanceof HTMLElement && returnFocusTo.isConnected) {
        returnFocusTo.focus({ preventScroll: true });
      } else if (returnCourtId !== undefined) {
        const court = document.querySelector<HTMLElement>(`[data-court-id="${returnCourtId}"]`);
        (court?.querySelector<HTMLElement>('.court-card__footer .button--primary:not(:disabled)') ?? court)?.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const hasExpired = proposal.status === 'expired'
    || (proposal.status === 'pending' && now !== null && now >= proposal.expiresAt);
  const isPending = proposal.status === 'pending' && !hasExpired;
  const isBusy = isSaving || isProposalLoading;
  const secondsRemaining = now === null
    ? null
    : Math.max(0, Math.ceil((proposal.expiresAt - now) / 1000));
  return (
    <AnimatedDialog
        ref={dialogRef}
        className="dialog dialog--proposal"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          if (!isBusy) void onDismiss();
        }}
      >
        <div className="dialog__header">
          <div>
            <h2 id={titleId}>Match review</h2>
            {isPending && secondsRemaining !== null ? (
              <span className="proposal-expiry" role="timer" aria-label={`Expires in ${secondsRemaining} seconds`}>
                {secondsRemaining}s
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => void onDismiss()}
            disabled={isBusy}
            aria-label="Close match review"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="dialog__body proposal-body">
          {proposal.source === 'ai' ? <div className="matching-method"><span>Saved pairing</span></div> : null}
          {hasExpired ? (
            <div className="inline-alert inline-alert--warning" role="status">
              Expired
            </div>
          ) : null}

          {proposal.status === 'rejected' ? (
            <div className="inline-alert" role="status">Dismissed</div>
          ) : null}

          {proposal.status === 'applied' ? (
              <div className="inline-alert inline-alert--success" role="status">Assigned</div>
          ) : null}

          {error ? (
            <div className="inline-alert inline-alert--error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="proposal-teams">
            {[0, 1].map((team) => <section className="court-team" key={team}><h3>Team {team + 1}</h3><ol className="proposal-roster" aria-label={`Team ${team + 1}`}>
              {proposal.players.slice(team * proposal.players.length / 2, (team + 1) * proposal.players.length / 2).map((player) => <li key={player.id}><span>{player.name}<small className="proposal-player-level">{player.skillLevel}</small></span><small aria-label={player.skillRating === null ? 'Local rating not recorded' : undefined}>{player.skillRating?.toFixed(1) ?? '—'}</small></li>)}
            </ol></section>)}
          </div>
          {isPending ? <label className="form-field"><span>Assign to</span><select value={courtId ?? ''} disabled={isBusy} onChange={(event) => setCourtId(event.target.value ? Number(event.target.value) : undefined)}>
            <option value="">Next game</option>
            {!selectedCourtAvailable && courtId !== undefined ? <option value={courtId} disabled>{courts.find((court) => court.id === courtId)?.name ?? `Court ${courtId}`} — unavailable</option> : null}
            {availableCourts.map((court) => <option key={court.id} value={court.id}>{court.name ?? `Court ${court.id}`}</option>)}
          </select></label> : null}
          {isPending && proposal.mixed ? <label className="checkbox-field mixed-approval"><input type="checkbox" checked={mixedApproval} onChange={(event) => setMixedApproval(event.target.checked)} disabled={isBusy} /><span>Allow mixed levels</span></label> : null}
          {isPending && !selectedCourtAvailable ? <div className="inline-alert inline-alert--warning" role="status">{availableCourts.length ? 'Choose another court or Next game.' : 'Choose Next game to stage this group.'}</div> : null}

          <div className="dialog__actions">
            {hasExpired || error ? (
              <>
                <button type="button" className="button button--secondary" onClick={() => void onDismiss()} disabled={isBusy}>
                  Close
                </button>
                <button type="button" className="button button--primary" onClick={() => void onRequestAnother()} disabled={isBusy}>
                  {isProposalLoading ? <span className="spinner spinner--small" aria-hidden="true" /> : null}
                  Refresh
                </button>
              </>
            ) : isPending ? (
              <>
                <button type="button" className="button button--secondary" onClick={() => void onDismiss()} disabled={isBusy}>
                  Not now
                </button>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void onApprove(courtId, mixedApproval)}
                  disabled={isBusy || proposal.players.length !== playerCount || !selectedCourtAvailable || (proposal.mixed === true && !mixedApproval)}
                >
                  {isSaving ? <span className="spinner spinner--small" aria-hidden="true" /> : null}
                  {isSaving ? 'Assigning…' : courtId === undefined ? 'Stage group' : 'Assign court'}
                </button>
              </>
            ) : (
              <button type="button" className="button button--primary" onClick={() => void onDismiss()} disabled={isBusy}>
                Done
              </button>
            )}
          </div>
        </div>
    </AnimatedDialog>
  );
};
