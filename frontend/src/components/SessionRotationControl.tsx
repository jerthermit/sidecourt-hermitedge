import { useId, type RefObject } from 'react';

interface SessionRotationControlProps {
  waiting: number;
  emptyCourts: number;
  playerCount: number;
  busy: boolean;
  preparing: boolean;
  closed: boolean;
  onReview: () => void;
  onViewWaiting?: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

export function SessionRotationControl({ waiting, emptyCourts, playerCount, busy, preparing,
  closed, onReview, onViewWaiting, buttonRef }: SessionRotationControlProps) {
  const helpId = useId();
  const unavailable = closed || busy || preparing || emptyCourts === 0 || waiting < playerCount;
  const help = closed ? 'Start a new session to review a rotation.'
    : emptyCourts === 0 ? 'An empty, open court is required.'
      : waiting < playerCount ? `Waiting for ${playerCount - waiting} more ready players.`
        : 'Review teams across empty courts. Assignment requires approval and does not start play.';
  return <div className="session-rotation">
    <div className="session-rotation__context" aria-live="polite">
      {onViewWaiting ? <button type="button" className="session-rotation__waiting" aria-controls="player-queues"
        onClick={onViewWaiting}><strong>{waiting}</strong> waiting</button> : <span><strong>{waiting}</strong> waiting</span>}
      <span><strong>{emptyCourts}</strong> {emptyCourts === 1 ? 'empty court' : 'empty courts'}</span>
    </div>
    <button ref={buttonRef} type="button" className="button button--primary session-rotation__action"
      aria-describedby={helpId} disabled={unavailable} onClick={onReview}>
      {preparing ? <span className="spinner spinner--small" aria-hidden="true" /> : null}
      {preparing ? 'Preparing…' : 'Review rotation'}
    </button>
    <p id={helpId} className="sr-only">{help}</p>
  </div>;
}
