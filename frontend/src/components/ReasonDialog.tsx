import { useEffect, useId, useRef, useState } from 'react';
import { AnimatedDialog } from './AnimatedDialog';

interface ReasonDialogProps {
  title: string;
  message: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<boolean>;
}

export function ReasonDialog({ title, message, busy, error, onClose, onConfirm }: ReasonDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    const dialog = dialogRef.current;
    const origin = document.activeElement;
    dialog?.showModal();
    reasonRef.current?.focus();
    return () => {
      dialog?.close();
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true });
    };
  }, []);
  return <AnimatedDialog ref={dialogRef} className="dialog dialog--small" aria-labelledby={id} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog__header"><h2 id={id}>{title}</h2><button type="button" className="icon-button" aria-label="Close confirmation" disabled={busy} onClick={onClose}><span aria-hidden="true">×</span></button></div>
    <form className="dialog__body form-stack" onSubmit={async (event) => { event.preventDefault(); if (reason.trim().length >= 3 && await onConfirm(reason.trim())) onClose(); }}>
      <p className="correction-note">{message}</p>
      {error ? <div className="inline-alert inline-alert--error" role="alert">{error}</div> : null}
      <label className="field"><span>Reason</span><textarea ref={reasonRef} required minLength={3} maxLength={160} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} rows={3} /></label>
      <div className="dialog__actions"><button type="button" className="button button--secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button button--danger" disabled={busy || reason.trim().length < 3}>{busy ? 'Saving…' : 'Void match'}</button></div>
    </form>
  </AnimatedDialog>;
}
