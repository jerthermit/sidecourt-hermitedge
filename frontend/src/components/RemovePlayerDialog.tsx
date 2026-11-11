import { useEffect, useId, useRef, useState } from 'react';
import { AnimatedDialog } from './AnimatedDialog';
import type { Player } from '../types/models';

interface RemovePlayerDialogProps {
  player: Player;
  busy: boolean;
  error: string | null;
  blockedReason?: string | null;
  returnFocusTo?: HTMLElement | null;
  onRemove: (playerId: string) => Promise<boolean>;
  onClose: () => void;
}

export function RemovePlayerDialog({ player, busy, error, blockedReason = null, returnFocusTo = null,
  onRemove, onClose }: RemovePlayerDialogProps) {
  const titleId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const requestInFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = busy || submitting;

  useEffect(() => {
    const dialog = dialogRef.current;
    const origin = returnFocusTo ?? document.activeElement;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog?.close();
      const disabled = origin instanceof HTMLButtonElement ? origin.disabled
        : origin instanceof HTMLElement && origin.getAttribute('aria-disabled') === 'true';
      if (origin instanceof HTMLElement && origin.isConnected && !disabled) origin.focus({ preventScroll: true });
      else document.querySelector<HTMLButtonElement>('[aria-label="Workspace"] button[aria-pressed="true"]')?.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  return <AnimatedDialog ref={dialogRef} className="dialog dialog--small remove-player-dialog" aria-labelledby={titleId}
    aria-describedby={`${nameId} ${descriptionId}`}
    onCancel={(event) => { event.preventDefault(); if (!locked) onClose(); }}>
    <div className="dialog__header">
      <h2 id={titleId}>Remove player</h2>
      <button type="button" className="icon-button" aria-label="Close remove player confirmation"
        disabled={locked} onClick={onClose}><span aria-hidden="true">×</span></button>
    </div>
    <form className="dialog__body form-stack" onSubmit={async (event) => {
      event.preventDefault();
      if (locked || blockedReason || requestInFlight.current) return;
      requestInFlight.current = true;
      setSubmitting(true);
      try {
        if (await onRemove(player.id)) onClose();
      } finally {
        requestInFlight.current = false;
        setSubmitting(false);
      }
    }}>
      <p id={nameId} className="remove-player-name">{player.name}</p>
      <p id={descriptionId} className="correction-note">Remove from roster. Recorded match/session history remains.</p>
      {blockedReason ? <div className="inline-alert inline-alert--warning" role="status">{blockedReason}</div> : null}
      {error ? <div className="inline-alert inline-alert--error" role="alert">{error}</div> : null}
      <div className="dialog__actions">
        <button ref={cancelRef} type="button" className="button button--secondary" disabled={locked} onClick={onClose}>Cancel</button>
        <button type="submit" className="button button--danger" disabled={locked || Boolean(blockedReason)}>
          {submitting ? 'Removing…' : 'Remove player'}
        </button>
      </div>
    </form>
  </AnimatedDialog>;
}
