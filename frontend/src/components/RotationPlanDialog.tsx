import { useEffect, useId, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { AnimatedDialog } from './AnimatedDialog';
import { interactionEase, useMotionPolicy } from '../lib/interactionMotion';
import type { Player, RotationPlan } from '../types/models';
import { canApproveRotation, rotationApprovalKey } from '../lib/rotationReview';

interface RotationPlanDialogProps {
  plan: RotationPlan | null;
  busy: boolean;
  error: string | null;
  onRefresh: (allowMixed?: boolean) => Promise<boolean>;
  onApprove: (approveMixed: boolean) => Promise<boolean>;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}

const gameCount = (player: Player): string => {
  if (player.gamesPlayed === undefined) return 'Games —';
  return `${player.gamesPlayed} ${player.gamesPlayed === 1 ? 'game' : 'games'}`;
};

function RotationPlayer({ player }: { player: Player }) {
  return <li>
    <strong>{player.name}</strong>
    <span className="rotation-player__record">
      <span aria-label={player.skillRating === null ? 'Local rating not recorded' : undefined}>
        {player.skillRating?.toFixed(1) ?? 'Rating —'}
      </span>
      <span>{gameCount(player)}</span>
    </span>
  </li>;
}

function Assignment({ assignment }: { assignment: RotationPlan['assignments'][number] }) {
  const { reduced } = useMotionPolicy();
  const courtName = assignment.courtName.trim() || `Court ${assignment.courtId}`;
  const teamSize = Math.floor(assignment.players.length / 2);
  const hasCompleteRatings = assignment.players.every((player) => player.skillRating !== null);
  const notes = [
    !hasCompleteRatings || assignment.metrics.ratingDifference === null
      ? null
      : `Team rating gap ${assignment.metrics.ratingDifference.toFixed(1)}`,
    assignment.metrics.repeatPartners > 0
      ? `${assignment.metrics.repeatPartners} repeat ${assignment.metrics.repeatPartners === 1 ? 'partner' : 'partners'}`
      : null,
    assignment.metrics.repeatOpponents > 0
      ? `${assignment.metrics.repeatOpponents} repeat ${assignment.metrics.repeatOpponents === 1 ? 'opponent' : 'opponents'}`
      : null,
  ].filter((note): note is string => note !== null);

  return <motion.section className="rotation-court" aria-labelledby={`rotation-court-${assignment.courtId}`}
    variants={{ hidden: { opacity: 0, y: reduced ? 0 : 6 }, visible: { opacity: 1, y: 0,
      transition: { type: 'tween', duration: reduced ? 0 : 0.22, ease: interactionEase } } }}>
    <div className="rotation-court__heading">
      <h3 id={`rotation-court-${assignment.courtId}`}>{courtName}</h3>
      {assignment.mixed ? <span>Mixed</span> : null}
    </div>
    <div className="rotation-teams">
      {[0, 1].map((team) => {
        const players = team === 0
          ? assignment.players.slice(0, teamSize)
          : assignment.players.slice(teamSize);
        return <section className="rotation-team" key={team}>
          <h4>Team {team + 1}</h4>
          <ol aria-label={`${courtName}, Team ${team + 1}`}>
            {players.map((player) => <RotationPlayer key={player.id} player={player} />)}
          </ol>
        </section>;
      })}
    </div>
    {notes.length > 0 ? <p className="rotation-court__notes">{notes.join(' · ')}</p> : null}
  </motion.section>;
}

export function RotationPlanDialog({ plan, busy, error, onRefresh, onApprove, onClose,
  returnFocusTo = null }: RotationPlanDialogProps) {
  const { reduced } = useMotionPolicy();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(returnFocusTo);
  const committedCourt = useRef<number | null>(null);
  const [approvedMixedKey, setApprovedMixedKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const dialog = dialogRef.current;
    const origin = returnFocusRef.current ?? document.activeElement;
    dialog?.showModal();
    closeRef.current?.focus();
    return () => {
      dialog?.close();
      const court = committedCourt.current === null ? null
        : document.querySelector<HTMLElement>(`[data-court-id="${committedCourt.current}"]`);
      const assignedAction = court?.querySelector<HTMLElement>('.court-card__footer .button--primary:not(:disabled)') ?? court;
      if (assignedAction) {
        assignedAction.focus({ preventScroll: true });
        return;
      }
      const disabled = origin instanceof HTMLButtonElement || origin instanceof HTMLInputElement
        || origin instanceof HTMLSelectElement || origin instanceof HTMLTextAreaElement
        ? origin.disabled
        : origin instanceof HTMLElement && origin.getAttribute('aria-disabled') === 'true';
      if (origin instanceof HTMLElement && origin.isConnected && !disabled) origin.focus({ preventScroll: true });
    };
  }, []);

  const planId = plan?.id;
  const planRevision = plan?.revision;
  const planStatus = plan?.status;
  const planExpiresAt = plan?.expiresAt;
  useEffect(() => {
    if (!planId || planStatus !== 'pending' || planExpiresAt === undefined) return;
    const update = () => {
      const next = Date.now();
      setNow(next);
      if (next >= planExpiresAt) window.clearInterval(timer);
    };
    const timer = window.setInterval(update, 1000);
    const firstTick = window.setTimeout(update, 0);
    return () => { window.clearInterval(timer); window.clearTimeout(firstTick); };
  }, [planExpiresAt, planId, planRevision, planStatus]);

  const expired = plan !== null && (plan.status === 'expired' || now >= plan.expiresAt);
  const pending = plan?.status === 'pending' && !expired;
  const assignments = plan?.assignments ?? [];
  const hasMixedAssignments = assignments.some((assignment) => assignment.mixed);
  const approveMixed = plan !== null && approvedMixedKey === rotationApprovalKey(plan);
  const assignmentCount = assignments.length;
  const canApprove = canApproveRotation(plan, error, approvedMixedKey, now);
  const secondsRemaining = plan === null ? 0 : Math.max(0, Math.ceil((plan.expiresAt - now) / 1000));
  const refreshCurrent = () => onRefresh(plan?.allowMixed ? true : undefined);
  const policyLabel = plan?.policy.rotationMode === 'skill-banded' ? 'Skill-banded rotation' : 'Open rotation';

  return <AnimatedDialog ref={dialogRef} className="dialog rotation-plan-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog__header rotation-plan-header">
      <div>
        <h2 id={titleId}>Rotation plan</h2>
        {plan ? <span className="rotation-plan-policy">
          {policyLabel}
        </span> : null}
      </div>
      <div className="rotation-plan-header__actions">
        {pending ? <span className="proposal-expiry" role="timer"
          aria-label={`Expires in ${secondsRemaining} seconds`}>{secondsRemaining}s</span> : null}
        <button ref={closeRef} type="button" className="icon-button" aria-label="Close rotation plan"
          disabled={busy} onClick={onClose}><span aria-hidden="true">×</span></button>
      </div>
    </div>

    <form className="dialog__body rotation-plan-body" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || !canApproveRotation(plan, error, approvedMixedKey, Date.now())) return;
      const firstCourtId = plan?.assignments[0]?.courtId;
      if (await onApprove(approveMixed) && firstCourtId !== undefined) committedCourt.current = firstCourtId;
    }}>
      {busy && !plan ? <div className="rotation-plan-loading" role="status">
        <span className="spinner" aria-hidden="true" />Loading plan…
      </div> : null}
      {error ? <div className="inline-alert inline-alert--error" role="alert">{error}</div> : null}
      {expired ? <div className="inline-alert inline-alert--warning" role="status">Plan expired.</div> : null}
      {plan?.status === 'applied' ? <div className="inline-alert inline-alert--success" role="status">Rotation assigned.</div> : null}
      {plan?.status === 'rejected' ? <div className="inline-alert" role="status">Rotation closed.</div> : null}
      {plan?.blockedReason ? <div className="inline-alert inline-alert--warning" role="status">{plan.assignments.length > 0 ? 'Remaining courts: ' : ''}{plan.blockedReason}</div> : null}
      {!busy && !plan && !error ? <p className="rotation-plan-empty" role="status">No rotation plan available.</p> : null}

      {assignments.length > 0 ? <motion.div key={plan?.id} className="rotation-assignments"
        data-rotation-plan-id={plan?.id}
        initial={reduced ? false : 'hidden'} animate="visible"
        variants={{ hidden: {}, visible: { transition: { staggerChildren: reduced ? 0 : 0.035 } } }}>
        {assignments.map((assignment) => <Assignment key={assignment.courtId} assignment={assignment} />)}
      </motion.div> : plan && !plan.blockedReason && !expired ? <p className="rotation-plan-empty" role="status">No complete rotation is available.</p> : null}

      {plan ? <section className="rotation-waiting" aria-labelledby="rotation-waiting-title">
        <h3 id="rotation-waiting-title">Waiting <span>{plan.waiting.length}</span></h3>
        {plan.waiting.length > 0 ? <ol>
          {plan.waiting.map((player) => <li key={player.id}>
            <span>{player.name}</span><small>{gameCount(player)}</small>
          </li>)}
        </ol> : null}
      </section> : null}

      {hasMixedAssignments ? <label className="checkbox-field mixed-approval rotation-mixed-approval">
        <input type="checkbox" checked={approveMixed}
          onChange={(event) => setApprovedMixedKey(event.target.checked && plan ? rotationApprovalKey(plan) : null)} disabled={busy || !pending} />
        <span>Approve mixed groups</span>
      </label> : null}

      <div className="dialog__actions rotation-plan-actions">
        <button type="button" className="button button--secondary" disabled={busy} onClick={onClose}>Close</button>
        {plan?.canMix && !plan.allowMixed ? <button type="button" className="button button--secondary"
          disabled={busy || !pending} onClick={() => void onRefresh(true)}>Review mixed groups</button> : null}
        {(!plan || error || expired || assignments.length === 0) && plan?.status !== 'applied'
          && plan?.status !== 'rejected' ? <button type="button" className="button button--primary"
            disabled={busy} onClick={() => void refreshCurrent()}>{busy ? 'Refreshing…' : 'Refresh plan'}</button> : null}
        {assignmentCount > 0 && plan?.status !== 'applied' && plan?.status !== 'rejected' ? <button type="submit"
          className="button button--primary" disabled={busy || !canApprove}>
          {busy ? 'Assigning…' : `Assign ${assignmentCount} ${assignmentCount === 1 ? 'court' : 'courts'}`}
        </button> : null}
      </div>
    </form>
  </AnimatedDialog>;
}
